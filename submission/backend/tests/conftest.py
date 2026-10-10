"""Tests never reach Gemini: no API call and no shared cache."""

import pytest

from anonymizer import gemini_client


def _no_api(model, prompt, schema):
    raise AssertionError("tests must not call the Gemini API")


@pytest.fixture(autouse=True)
def offline(monkeypatch, tmp_path):
    monkeypatch.setattr(gemini_client, "_call", _no_api)
    monkeypatch.setattr(gemini_client, "CACHE_DIR", tmp_path / "gemini-cache")
