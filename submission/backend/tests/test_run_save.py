"""#8: keep the model's answer of a run and replay it without the API."""

import json
from pathlib import Path

import pytest

from anonymizer import __main__ as cli
from anonymizer import detector, extract, gemini_client, pipeline

TEXT = "Nome: Ana Correia \nTelefone: 912 345 678 \nFim "
ANSWER = (
    '{"spans": [{"line": 1, "text": "Ana Correia", "category": "NAME",'
    ' "reason": "name"}, {"line": 2, "text": "912 345 678",'
    ' "category": "CONTACT", "reason": "phone"}]}'
)
EXPECTED = "Nome: * * \nTelefone: * * * \nFim "


@pytest.fixture
def fake_gemini(monkeypatch, tmp_path):
    """One fake API answer; the cache lives in a temporary folder."""
    calls = []
    monkeypatch.setattr(gemini_client, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(
        gemini_client, "_call",
        lambda model, prompt, schema: calls.append(prompt) or ANSWER,
    )
    monkeypatch.setattr(extract, "extract_text", lambda path: TEXT)
    return calls


def test_save_run_keeps_the_answer_and_the_run_details(fake_gemini, tmp_path):
    run = tmp_path / "outputs"

    masked = pipeline.anonymize(Path("doc.pdf"), save_run=run)

    assert masked == EXPECTED
    assert (run / detector.RUN_SPANS).read_text("utf-8") == ANSWER
    info = json.loads((run / detector.RUN_INFO).read_text("utf-8"))
    assert info["model"] == gemini_client.get_model()
    assert info["prompt_file"] == "prompt.txt"
    assert info["document_sha256"] == detector._sha256(TEXT)
    assert info["document_lines"] == 3
    assert len(info["prompt_sha256"]) == 64 and info["created_at"]


def test_from_run_reproduces_the_output_without_the_api(fake_gemini, tmp_path):
    run = tmp_path / "outputs"
    first = pipeline.anonymize(Path("doc.pdf"), save_run=run)
    assert fake_gemini == [detector.build_prompt(TEXT)]

    # No API and no cache from here on: only spans.json may be used.
    (gemini_client.CACHE_DIR / "poison").mkdir(parents=True, exist_ok=True)
    fake_gemini.clear()
    gemini_client.CACHE_DIR.rename(tmp_path / "gone")

    assert pipeline.anonymize(Path("doc.pdf"), from_run=run) == first
    assert fake_gemini == []


def test_cli_save_then_replay(fake_gemini, tmp_path):
    run, out = tmp_path / "outputs", tmp_path / "submission.txt"

    assert cli.main(["doc.pdf", "--save-run", str(run), "-o", str(out)]) == 0
    saved = out.read_text("utf-8")
    out.unlink()

    assert cli.main(["doc.pdf", "--from-run", str(run), "-o", str(out)]) == 0
    assert out.read_text("utf-8") == saved == EXPECTED


def test_cli_rejects_save_and_replay_together(tmp_path):
    with pytest.raises(SystemExit):
        cli.main(["doc.pdf", "--save-run", "a", "--from-run", "b"])
