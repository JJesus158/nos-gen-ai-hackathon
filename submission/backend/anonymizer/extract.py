"""PDF text extraction using PyMuPDF, with OCR for scanned pages."""
from bisect import bisect_right
from dataclasses import dataclass
import os
from pathlib import Path
from typing import Optional

import pymupdf

OCR_DPI = 300


def ocr_language() -> str:
    """Tesseract languages to use: Portuguese and English when installed
    (the Docker image has both), "" when Tesseract is not available."""
    try:
        tessdata = pymupdf.get_tessdata()
    except Exception:
        return ""
    if not tessdata:
        return ""
    return "+".join(
        lang for lang in ("por", "eng")
        if os.path.exists(os.path.join(tessdata, f"{lang}.traineddata"))
    )


def page_textpage(page: pymupdf.Page) -> Optional[pymupdf.TextPage]:
    """OCR text for a scanned page (images, no text layer), else None.

    Pass the result as `textpage=` to page.get_text(); None reads the
    page's own text. The PDF rebuild calls this too, so both see the
    same words in the same places.
    """
    text = page.get_text("text")
    # Keep this helper compatible with lightweight page doubles used by tests.
    if not isinstance(text, str) or text.strip() or not hasattr(page, "get_images"):
        return None
    if not page.get_images():
        return None
    language = ocr_language()
    if not language:
        return None
    return page.get_textpage_ocr(language=language, dpi=OCR_DPI, full=True)


@dataclass(frozen=True)
class PdfCharacter:
    start: int
    end: int
    page: int
    line: int
    text: str
    # Native, unrotated PDF coordinates (bottom-left), as used by pdf-lib.
    rect: tuple[float, float, float, float]


@dataclass(frozen=True)
class ExtractedDocument:
    text: str
    characters: tuple[PdfCharacter, ...]

    def boxes_for(self, start: int, end: int) -> list[dict]:
        """Map an API UTF-16 interval to its glyphs, without searching text."""
        first = bisect_right(self.characters, start, key=lambda char: char.end)
        lines: dict[tuple[int, int], list[PdfCharacter]] = {}
        for index in range(first, len(self.characters)):
            char = self.characters[index]
            if char.start >= end:
                break
            if not char.text.isspace():
                lines.setdefault((char.page, char.line), []).append(char)

        boxes = []
        for (page, _), chars in lines.items():
            x0 = min(char.rect[0] for char in chars)
            y0 = min(char.rect[1] for char in chars)
            x1 = max(char.rect[2] for char in chars)
            y1 = max(char.rect[3] for char in chars)
            if x1 > x0 and y1 > y0:
                boxes.append(dict(
                    start=max(start, chars[0].start),
                    end=min(end, chars[-1].end),
                    page=page, x=x0, y=y0, width=x1 - x0, height=y1 - y0,
                ))
        return boxes


def _extract_layout(document: pymupdf.Document) -> ExtractedDocument:
    lines: list[str] = []
    characters: list[PdfCharacter] = []
    offset = 0
    for page_number, page in enumerate(document, start=1):
        # The text and geometry share the exact same extraction order/flags.
        raw = page.get_text(
            "rawdict",
            sort=False,
            flags=pymupdf.TEXTFLAGS_TEXT,
            textpage=page_textpage(page),
        )
        # PyMuPDF's transform for rotated crop boxes is relative to the crop
        # area. Resolve it unrotated so the API always returns native PDF units.
        rotation = page.rotation
        try:
            page.set_rotation(0)
            to_pdf = ~page.transformation_matrix
        finally:
            page.set_rotation(rotation)
        for block in raw["blocks"]:
            if block["type"] != 0:
                continue
            for line in block["lines"]:
                chars = [char for span in line["spans"] for char in span["chars"]]
                value = "".join(char["c"] for char in chars).rstrip()
                if not value.strip():
                    continue
                if lines:
                    offset += 1  # The same newline added to originalText.
                lines.append(value)
                remaining = len(value)
                for char in chars:
                    if remaining <= 0:
                        break
                    text = char["c"][:remaining]
                    remaining -= len(text)
                    units = len(text.encode("utf-16-le")) // 2
                    rect = pymupdf.Rect(char["bbox"]) * to_pdf
                    characters.append(PdfCharacter(
                        start=offset, end=offset + units, page=page_number,
                        line=len(lines), text=text, rect=tuple(rect),
                    ))
                    offset += units

    if not lines:
        raise ValueError("PDF contains no extractable text.")
    return ExtractedDocument("\n".join(lines), tuple(characters))


def _extract_document(document: pymupdf.Document) -> str:
    return _extract_layout(document).text


def extract_layout_from_bytes(data: bytes) -> ExtractedDocument:
    """Extract originalText and its UTF-16 character positions together."""
    with pymupdf.open(stream=data, filetype="pdf") as document:
        return _extract_layout(document)


def extract_text(pdf_path: Path | str) -> str:
    """Extract text from a PDF using its file path."""

    pdf_path = Path(pdf_path)

    if not pdf_path.is_file():
        raise FileNotFoundError(
            f"PDF not found: {pdf_path}"
        )

    with pymupdf.open(str(pdf_path)) as document:
        return _extract_document(document)


def extract_text_from_bytes(data: bytes) -> str:
    """Extract text directly from PDF bytes without saving a file."""

    with pymupdf.open(
        stream=data,
        filetype="pdf"
    ) as document:
        return _extract_document(document)
