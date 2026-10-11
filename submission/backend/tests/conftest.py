"""Tests never reach Gemini: no API call and no shared cache."""

import pymupdf
import pytest

from anonymizer import gemini_client


def _no_api(model, prompt, schema):
    raise AssertionError("tests must not call the Gemini API")


@pytest.fixture(autouse=True)
def offline(monkeypatch, tmp_path):
    monkeypatch.setattr(gemini_client, "_call", _no_api)
    monkeypatch.setattr(gemini_client, "CACHE_DIR", tmp_path / "gemini-cache")


@pytest.fixture
def scanned_pdf():
    """Factory for a PDF whose only content is a picture of the lines,
    like a scan: no text layer, so reading it needs OCR."""
    def make(lines):
        with pymupdf.open() as text_doc:
            page = text_doc.new_page()
            for i, line in enumerate(lines):
                page.insert_text((72, 100 + 40 * i), line, fontsize=16)
            picture = page.get_pixmap(dpi=200)
        with pymupdf.open() as scan:
            page = scan.new_page()
            page.insert_image(page.rect, pixmap=picture)
            return scan.tobytes()
    return make
