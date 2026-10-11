
"""Reconstruct PDFs with compact groups of masked words."""

import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

import pymupdf

from anonymizer.extract import extract_text_from_bytes, page_textpage
from anonymizer.masker import mask_with_positions, runs
from anonymizer.spans import Span

OCR_PADDING = 1.5  # points around OCR word boxes
# Base-14 Courier Bold: its "*" sits at mid height and reads at small
# sizes; Helvetica's is thin and floats near the cap height.
MASK_FONT = "cobo"
# Half the side of the box that removes one glyph of a tilted line: MuPDF
# removes a glyph when the box touches the glyph's ink.
GLYPH_PROBE = 0.1
POSITION_TOLERANCE = 0.5  # points, comparing words before/after redaction
HORIZONTAL = (1.0, 0.0)


@dataclass(frozen=True)
class _Glyph:
    """One character of a PDF word, with the style of its span."""

    char: str
    origin: pymupdf.Point
    bbox: pymupdf.Rect
    size: float
    color: int


@dataclass(frozen=True)
class _Word:
    """A word of page.get_text("words") and the line it sits on.

    glyphs is None when the characters of the word could not be told
    apart; such a word can be kept, but not masked.
    """

    text: str
    box: pymupdf.Rect
    direction: Optional[Tuple[float, float]]
    glyphs: Optional[Tuple[_Glyph, ...]]


@dataclass(frozen=True)
class _Mask:
    """The asterisks that replace one run, drawn after the redactions."""

    page: int
    origin: pymupdf.Point
    direction: Tuple[float, float]
    size: float
    color: int
    length: float  # room along the line, from origin to the run's end
    text: str


def _is_delimiter(char: str) -> bool:
    """What PyMuPDF's word extraction splits words on."""
    code = ord(char)
    return code <= 32 or code == 160 or 0x202A <= code <= 0x202E


def _line_words(line: dict) -> List[List[_Glyph]]:
    """The characters of each word of a rawdict line, in order."""
    words: List[List[_Glyph]] = []
    current: List[_Glyph] = []
    for span in line["spans"]:
        for char in span["chars"]:
            if _is_delimiter(char["c"]):
                if current:
                    words.append(current)
                current = []
                continue
            if not current and char["c"] == "\u200d":
                continue  # a zero width joiner cannot start a word
            current.append(_Glyph(
                char["c"], pymupdf.Point(char["origin"]),
                pymupdf.Rect(char["bbox"]), span["size"], span["color"],
            ))
    if current:
        words.append(current)
    return words


def _page_words(page: pymupdf.Page,
                textpage: Optional[pymupdf.TextPage]) -> List[_Word]:
    """Words in reading order, each with its characters and direction.

    textpage: the OCR of a scanned page, or None for the page's own text.
    Words and characters are read from one text page, so the numbers of
    page.get_text("words") point into page.get_text("rawdict").
    """
    if textpage is None:
        textpage = page.get_textpage(flags=pymupdf.TEXTFLAGS_WORDS)
    lines = {}
    for block in page.get_text("rawdict", textpage=textpage)["blocks"]:
        if block["type"] != 0:
            continue
        for line_index, line in enumerate(block["lines"]):
            direction = tuple(line["dir"])
            for word_index, glyphs in enumerate(_line_words(line)):
                lines[(block["number"], line_index, word_index)] = (
                    direction, tuple(glyphs),
                )

    words = []
    for word in page.get_text("words", sort=False, textpage=textpage):
        direction, glyphs = lines.get(tuple(word[5:8]), (None, None))
        if glyphs is None or "".join(g.char for g in glyphs) != word[4]:
            direction, glyphs = None, None
        words.append(_Word(word[4], pymupdf.Rect(word[:4]), direction, glyphs))
    return words


def _ink_centres(page: pymupdf.Page) -> Dict[tuple, pymupdf.Point]:
    """A point inside the ink of every character, by character origin.

    With accurate boxes a character's box spans its advance and its ink
    height, so the box centre is inside the ink of nearly every glyph,
    even a "." that sits on the baseline.
    """
    raw = page.get_text(
        "rawdict",
        flags=pymupdf.TEXTFLAGS_WORDS | pymupdf.TEXT_ACCURATE_BBOXES,
    )
    centres = {}
    for block in raw["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                for char in span["chars"]:
                    box = pymupdf.Rect(char["bbox"])
                    centres[_glyph_key(char["c"], char["origin"])] = (
                        (box.tl + box.br) / 2
                    )
    return centres


def _glyph_key(char: str, origin: Sequence[float]) -> tuple:
    return (char, round(origin[0], 3), round(origin[1], 3))


def _probe(centre: pymupdf.Point) -> pymupdf.Rect:
    return pymupdf.Rect(
        centre.x - GLYPH_PROBE, centre.y - GLYPH_PROBE,
        centre.x + GLYPH_PROBE, centre.y + GLYPH_PROBE,
    )


def _guard_boxes(word: _Word) -> List[pymupdf.Rect]:
    """Where a word must not be touched by a redaction.

    The box of a word on a tilted line also covers its neighbours, so
    such a word is checked letter by letter.
    """
    if word.direction == HORIZONTAL or word.glyphs is None:
        return [word.box]
    return [glyph.bbox for glyph in word.glyphs]


def _run_length(glyphs: Sequence[_Glyph], origin: pymupdf.Point,
                direction: Tuple[float, float]) -> float:
    """How far the run reaches along its line from `origin`."""
    dx, dy = direction
    return max(
        (corner.x - origin.x) * dx + (corner.y - origin.y) * dy
        for glyph in glyphs
        for corner in (glyph.bbox.tl, glyph.bbox.tr,
                       glyph.bbox.bl, glyph.bbox.br)
    )


def _insert_mask(page: pymupdf.Page, mask: _Mask) -> None:
    """Draw the asterisks where the value started, on its baseline.

    Same size and colour as the value, smaller only when the asterisks
    would not fit in the value's length, and along the value's
    direction when its line is rotated or tilted.
    """
    font = pymupdf.Font(MASK_FONT)
    width = font.text_length(mask.text, fontsize=1)
    if mask.length <= 0 or width <= 0 or mask.size <= 0:
        raise ValueError("Invalid mask rectangle; manual review required.")
    fontsize = min(mask.size, mask.length / width)

    angle = math.degrees(math.atan2(-mask.direction[1], mask.direction[0]))
    quarter = round(angle / 90)
    if abs(angle - 90 * quarter) < 0.01:
        turn = {"rotate": (90 * quarter) % 360}
    else:
        turn = {"morph": (mask.origin, pymupdf.Matrix(angle))}
    page.insert_text(
        mask.origin, mask.text, fontname=MASK_FONT, fontsize=fontsize,
        color=pymupdf.sRGB_to_pdf(mask.color), **turn,
    )


def _same_words(before: Sequence[_Word], page: pymupdf.Page) -> bool:
    """Whether the page still has exactly these words, in these places."""
    def key(text, box):
        return (text,) + tuple(round(value, 1) for value in box)

    expected = Counter(key(word.text, word.box) for word in before)
    found = Counter(
        key(word[4], word[:4]) for word in page.get_text("words")
    )
    missing = list((expected - found).elements())
    extra = list((found - expected).elements())
    # Rounding can split equal positions: match the rest with tolerance.
    for word in missing:
        match = next((
            other for other in extra
            if other[0] == word[0] and all(
                abs(a - b) <= POSITION_TOLERANCE
                for a, b in zip(word[1:], other[1:])
            )
        ), None)
        if match is None:
            return False
        extra.remove(match)
    return not extra


def _save_pdf(document: pymupdf.Document) -> bytes:
    """Clear PDF metadata and export the document."""

    document.set_metadata({})
    document.del_xml_metadata()

    return document.tobytes(
        garbage=4,
        deflate=True,
    )


def reconstruct_pdf(
    pdf_data: bytes,
    spans: Sequence[Span],
) -> bytes:
    """Reconstruct a PDF and return its anonymized bytes."""

    pdf_bytes, _ = reconstruct_pdf_with_report(
        pdf_data,
        spans,
    )

    return pdf_bytes


def reconstruct_pdf_with_report(
    pdf_data: bytes,
    spans: Sequence[Span],
) -> Tuple[bytes, List[Span]]:
    """Redact matched words and report unmatched sensitive spans.

    Raise ValueError for ambiguous geometry that needs manual review.
    This does not audit sensitive data in annotations or attachments.
    """

    original_text = extract_text_from_bytes(pdf_data)
    result = mask_with_positions(original_text, spans)

    # A document without sensitive words is a valid case.
    # Still clear its metadata before exporting.
    if not result.words:
        with pymupdf.open(
            stream=pdf_data,
            filetype="pdf",
        ) as document:
            return _save_pdf(document), result.unmatched

    original_lines = original_text.split("\n")
    masked_lines = result.text.split("\n")

    if len(original_lines) != len(masked_lines):
        raise ValueError("Masking changed the line count.")

    masked_words = {
        (word.line, word.index): word
        for word in result.words
    }

    if len(masked_words) != len(result.words):
        raise ValueError("Duplicate masked word positions.")

    word_locations = {}
    page_word_locations = {}
    ocr_pages = set()
    line_number = 0

    with pymupdf.open(
        stream=pdf_data,
        filetype="pdf",
    ) as document:

        # Step 1: Match text words to PDF coordinates.
        for page_index, page in enumerate(document):
            # Scanned pages: OCR words and their boxes, as extract saw them.
            ocr = page_textpage(page)
            if ocr is not None:
                ocr_pages.add(page_index)
            pdf_words = _page_words(page, ocr)
            word_cursor = 0
            page_word_locations[page_index] = []

            # Same lines as extract_text(), which drops the trailing
            # space PyMuPDF leaves on Word PDFs (#14).
            page_lines = [
                line.rstrip()
                for line in page.get_text(
                    "text", sort=False, textpage=ocr,
                ).split("\n")
                if line.strip()
            ]

            for line in page_lines:
                line_number += 1

                if (
                    line_number > len(original_lines)
                    or line != original_lines[line_number - 1]
                ):
                    raise ValueError("PDF line alignment failed.")

                original_tokens = re.findall(r"\S+", line)

                masked_tokens = re.findall(
                    r"\S+",
                    masked_lines[line_number - 1],
                )

                if len(original_tokens) != len(masked_tokens):
                    raise ValueError("Masking changed the word count.")

                for index, (original, masked) in enumerate(
                    zip(original_tokens, masked_tokens)
                ):
                    if word_cursor >= len(pdf_words):
                        raise ValueError("PDF word alignment failed.")

                    pdf_word = pdf_words[word_cursor]
                    word_cursor += 1

                    if pdf_word.text != original:
                        raise ValueError("PDF text position mismatch.")

                    key = (line_number, index)
                    page_word_locations[page_index].append((key, pdf_word))

                    if key in masked_words:
                        if masked_words[key].word != original:
                            raise ValueError("Masked word mismatch.")

                        word_locations[key] = (
                            page_index,
                            pdf_word,
                        )

                    elif original != masked:
                        raise ValueError("Unexpected text modification.")

            if word_cursor != len(pdf_words):
                raise ValueError("PDF word alignment incomplete.")

        if (
            line_number != len(original_lines)
            or set(word_locations) != set(masked_words)
        ):
            raise ValueError("Not all masked words were located.")

        # Step 2: Group consecutive sensitive words.
        changed_pages = set()
        masks = []
        ink_centres = {}

        for run in runs(result.words):
            positions = [
                word_locations[(run.line, index)]
                for index in range(run.first, run.last + 1)
            ]

            page_indexes = {
                page_index for page_index, _ in positions
            }

            if len(page_indexes) != 1:
                raise ValueError("Masked run crosses PDF pages.")

            page_index = positions[0][0]
            page = document[page_index]
            words = [word for _, word in positions]
            direction = words[0].direction
            if (
                any(word.glyphs is None for word in words)
                or any(word.direction != direction for word in words)
            ):
                raise ValueError(
                    "Masked text has no clear position on page "
                    f"{page_index + 1}; manual review required."
                )
            glyphs = [glyph for word in words for glyph in word.glyphs]

            if direction == HORIZONTAL:
                # One rectangle covers the entire sensitive run.
                rect = pymupdf.Rect(words[0].box)
                for word in words[1:]:
                    rect |= word.box

                # OCR boxes hug the glyphs; pad them so no sliver of a
                # letter is left in the scanned image.
                if page_index in ocr_pages:
                    rect = pymupdf.Rect(
                        rect.x0 - OCR_PADDING, rect.y0 - OCR_PADDING,
                        rect.x1 + OCR_PADDING, rect.y1 + OCR_PADDING,
                    )
                rects = [rect]
            else:
                # The upright box of a tilted run also covers the label
                # and the lines next to it, so each letter is removed on
                # its own, through a point inside its ink. Those points
                # would leave the value visible in a picture underneath
                # (a scan, with or without a text layer): review instead.
                area = pymupdf.Rect(glyphs[0].bbox)
                for glyph in glyphs[1:]:
                    area |= glyph.bbox
                if page_index in ocr_pages or any(
                    area.intersects(image["bbox"])
                    for image in page.get_image_info()
                ):
                    raise ValueError(
                        "Tilted text over an image on page "
                        f"{page_index + 1}; manual review required."
                    )
                if page_index not in ink_centres:
                    ink_centres[page_index] = _ink_centres(page)
                rects = []
                for glyph in glyphs:
                    centre = ink_centres[page_index].get(
                        _glyph_key(glyph.char, glyph.origin)
                    )
                    if centre is None:
                        raise ValueError(
                            "Tilted text has no clear position on page "
                            f"{page_index + 1}; manual review required."
                        )
                    rects.append(_probe(centre))

            # MuPDF removes every character whose box overlaps this area.
            # Reject ambiguous geometry before returning a damaged document.
            if any(
                rect.intersects(box)
                for key, word in page_word_locations[page_index]
                if key not in masked_words
                for box in _guard_boxes(word)
                for rect in rects
            ):
                raise ValueError(
                    "Redaction overlaps unmarked text on page "
                    f"{page_index + 1}; manual review required."
                )
            if any(page.annots(
                types=[pymupdf.PDF_ANNOT_REDACT],
            )) and page_index not in changed_pages:
                raise ValueError(
                    "Existing redaction annotations require manual review."
                )

            masked_tokens = re.findall(
                r"\S+",
                masked_lines[run.line - 1],
            )

            replacement = " ".join(
                masked_tokens[run.first:run.last + 1]
            )

            # Remove text first; insert masks after all redactions are applied.
            # fill=False keeps the area transparent, so cell colours and
            # table lines underneath stay; apply_redactions() still deletes
            # the text. (fill=None would mean white in PyMuPDF.)
            for rect in rects:
                page.add_redact_annot(
                    rect,
                    fill=False,
                    cross_out=False,
                )

            changed_pages.add(page_index)
            origin = glyphs[0].origin
            masks.append(_Mask(
                page_index, origin, direction, glyphs[0].size,
                # OCR text has no colour of its own: the scan is erased
                # to white, so draw black.
                0 if page_index in ocr_pages else glyphs[0].color,
                _run_length(glyphs, origin, direction), replacement,
            ))

        # Step 3: Apply redactions to the affected pages.
        for page_index in changed_pages:
            page = document[page_index]
            # images: on scanned pages the words are pixels, so the
            # pixels under each masked run are erased from the image.
            page.apply_redactions(
                images=pymupdf.PDF_REDACT_IMAGE_PIXELS, graphics=0,
            )
            # The checks above work on boxes; this one reads the result:
            # every unmarked word must still be there, every masked word
            # gone. (Scanned pages have no text layer to read.)
            kept = [
                word for key, word in page_word_locations[page_index]
                if key not in masked_words
            ]
            if page_index not in ocr_pages and not _same_words(kept, page):
                raise ValueError(
                    "Redaction changed unmarked text on page "
                    f"{page_index + 1}; manual review required."
                )

        for mask in masks:
            _insert_mask(document[mask.page], mask)

        # Step 4: Clear metadata and export the PDF.
        return _save_pdf(document), result.unmatched
