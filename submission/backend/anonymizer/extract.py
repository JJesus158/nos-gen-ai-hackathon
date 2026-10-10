"""PDF text extraction using PyMuPDF, with OCR for scanned pages."""
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
    if page.get_text("text").strip() or not page.get_images():
        return None
    language = ocr_language()
    if not language:
        return None
    return page.get_textpage_ocr(language=language, dpi=OCR_DPI, full=True)


def _extract_document(document: pymupdf.Document) -> str:

    lines = []

    for page in document:
        page_text = page.get_text(
            "text", sort=False, textpage=page_textpage(page),
        )

        for line in page_text.split("\n"):
            if line.strip():
                # PyMuPDF leaves a space before every line break in
                # Word-generated PDFs; the official sample has none (#14).
                lines.append(line.rstrip())

    if not lines:
        raise ValueError(
            "PDF contains no extractable text."
        )

    return "\n".join(lines)


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
