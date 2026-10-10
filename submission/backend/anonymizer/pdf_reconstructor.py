
"""Reconstruct PDFs with compact groups of masked words."""

import re
from typing import List, Sequence, Tuple

import pymupdf

from anonymizer.extract import extract_text_from_bytes
from anonymizer.masker import mask_with_positions, runs
from anonymizer.spans import Span


def _insert_mask(page: pymupdf.Page, rect: pymupdf.Rect,
                 replacement: str) -> None:
    """Fit a centered mask without the redaction API's 4pt limit."""
    font = pymupdf.Font("helv")
    width = font.text_length(replacement, fontsize=1)
    height = font.ascender - font.descender
    if rect.is_empty or rect.is_infinite or width <= 0:
        raise ValueError("Invalid mask rectangle; manual review required.")
    fontsize = min(13, rect.width / width, rect.height / height) * 0.95
    x = rect.x0 + (rect.width - width * fontsize) / 2
    y = (rect.y0 + rect.y1 +
         (font.ascender + font.descender) * fontsize) / 2
    page.insert_text(
        (x, y), replacement, fontname="helv", fontsize=fontsize,
    )


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
    rotated_lines = {}
    line_number = 0

    with pymupdf.open(
        stream=pdf_data,
        filetype="pdf",
    ) as document:

        # Step 1: Match text words to PDF coordinates.
        for page_index, page in enumerate(document):
            pdf_words = page.get_text("words", sort=False)
            word_cursor = 0
            page_word_locations[page_index] = []
            rotated_lines[page_index] = [
                pymupdf.Rect(line["bbox"])
                for block in page.get_text(
                    "dict", flags=(
                        pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
                    ),
                )["blocks"]
                if block["type"] == 0
                for line in block["lines"]
                if line["dir"] != (1.0, 0.0)
            ]

            # Same lines as extract_text(), which drops the trailing
            # space PyMuPDF leaves on Word PDFs (#14).
            page_lines = [
                line.rstrip()
                for line in page.get_text(
                    "text", sort=False
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

                    if pdf_word[4] != original:
                        raise ValueError("PDF text position mismatch.")

                    key = (line_number, index)
                    box = pymupdf.Rect(pdf_word[:4])
                    page_word_locations[page_index].append((key, box))

                    if key in masked_words:
                        if masked_words[key].word != original:
                            raise ValueError("Masked word mismatch.")

                        word_locations[key] = (
                            page_index,
                            box,
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

            # One rectangle covers the entire sensitive run.
            rect = pymupdf.Rect(positions[0][1])

            for _, box in positions[1:]:
                rect |= box

            # MuPDF removes every character whose box overlaps this area.
            # Reject ambiguous geometry before returning a damaged document.
            if any(
                key not in masked_words and rect.intersects(box)
                for key, box in page_word_locations[page_index]
            ):
                raise ValueError(
                    "Redaction overlaps unmarked text on page "
                    f"{page_index + 1}; manual review required."
                )
            if any(rect.intersects(box)
                   for box in rotated_lines[page_index]):
                raise ValueError(
                    "Rotated sensitive text requires manual review."
                )
            if any(document[page_index].annots(
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
            document[page_index].add_redact_annot(
                rect,
                fill=False,
                cross_out=False,
            )

            changed_pages.add(page_index)
            masks.append((page_index, rect, replacement))

        # Step 3: Apply redactions to the affected pages.
        for page_index in changed_pages:
            document[page_index].apply_redactions(
                graphics=0
            )

        for page_index, rect, replacement in masks:
            _insert_mask(document[page_index], rect, replacement)

        # Step 4: Clear metadata and export the PDF.
        return _save_pdf(document), result.unmatched
