"""PDF text extraction using PyMuPDF."""
from pathlib import Path
import pymupdf


def _extract_document(document: pymupdf.Document) -> str:

    lines = []

    for page in document:
        page_text = page.get_text("text", sort=False)

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
