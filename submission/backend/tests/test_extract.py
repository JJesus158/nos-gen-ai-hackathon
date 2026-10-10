from pathlib import Path

import pymupdf
import pytest

from anonymizer import extract
from anonymizer.extract import extract_text, extract_text_from_bytes

CHALLENGE_PDF = (
    Path(__file__).resolve().parents[3]
    / "raw_data" / "document_to_anonymize.pdf"
)


def test_challenge_document_matches_the_official_sample():
    """#14: no trailing spaces, so the first lines equal the sample."""
    lines = extract_text(CHALLENGE_PDF).split("\n")

    assert lines[:4] == [
        "Relatório de Admissão - Centro Médico Lisboa",
        "Data: 15 de abril de 2025",
        "Referência: ADM-2025-04-15-089",
        "Informações do Paciente:",
    ]
    assert all(line == line.rstrip() for line in lines)
    assert all(line.strip() for line in lines)
    assert len(lines) == 60
    assert sum(len(line.split()) for line in lines) == 355


def test_extract_text_from_pdf(tmp_path):
    """Verify that text can be extracted from a real PDF."""
    pdf_path = tmp_path / "test.pdf"

    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((72, 72), "Nome: Ana Correia")
        page.insert_text((72, 100), "Telefone: 912345678")
        document.save(str(pdf_path))

    result = extract_text(pdf_path)

    assert result.splitlines() == [
        "Nome: Ana Correia",
        "Telefone: 912345678",
    ]


def test_extract_multiple_pages(tmp_path):
    """Verify text extraction preserves page order."""
    pdf_path = tmp_path / "multiple_pages.pdf"

    with pymupdf.open() as document:
        document.new_page().insert_text((72, 72), "Pagina 1")
        document.new_page().insert_text((72, 72), "Pagina 2")
        document.save(str(pdf_path))

    result = extract_text(pdf_path)

    assert result.splitlines() == ["Pagina 1", "Pagina 2"]


def test_missing_pdf(tmp_path):
    """Verify that a missing file raises an error."""
    pdf_path = tmp_path / "missing.pdf"

    with pytest.raises(FileNotFoundError):
        extract_text(pdf_path)


def test_empty_pdf(tmp_path):
    """Verify that a PDF without extractable text raises an error."""
    pdf_path = tmp_path / "empty.pdf"

    with pymupdf.open() as document:
        document.new_page()
        document.save(str(pdf_path))

    with pytest.raises(ValueError):
        extract_text(pdf_path)


def test_extract_text_with_string_path(tmp_path):
    """Verify that the function accepts a string path."""
    pdf_path = tmp_path / "test_string.pdf"

    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((72, 72), "Nome: Maria Santos")
        document.save(str(pdf_path))

    result = extract_text(str(pdf_path))

    assert "Nome: Maria Santos" in result


def test_extract_text_from_bytes():
    """Verify that PDF bytes can be processed directly."""
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((72, 72), "Nome: Ana Correia")
        pdf_bytes = document.tobytes()

    result = extract_text_from_bytes(pdf_bytes)

    assert "Nome: Ana Correia" in result


needs_ocr = pytest.mark.skipif(
    not extract.ocr_language(), reason="Tesseract is not installed",
)


@needs_ocr
def test_scanned_page_is_read_with_ocr(scanned_pdf):
    text = extract_text_from_bytes(
        scanned_pdf(["Nome: Ana Correia", "NIF: 123456789"])
    )

    assert text.split("\n") == ["Nome: Ana Correia", "NIF: 123456789"]


def test_scanned_page_without_tesseract_has_no_text(scanned_pdf,
                                                    monkeypatch):
    monkeypatch.setattr(extract, "ocr_language", lambda: "")

    with pytest.raises(ValueError):
        extract_text_from_bytes(scanned_pdf(["Nome: Ana Correia"]))
