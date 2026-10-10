from pathlib import Path

from anonymizer import __main__ as cli
from anonymizer import detector, extract, masker, pipeline
from anonymizer.spans import Category, Span

TEXT = "Nome: Ana Correia\nData: 15 de abril de 2025"
SPAN = Span(line=1, text="Ana Correia", category=Category.NAME)


def fake_steps(monkeypatch):
    """Replace the three steps so the wiring is tested on its own."""
    calls = []
    monkeypatch.setattr(
        extract, "extract_text",
        lambda path: calls.append(("extract", path)) or TEXT,
    )
    monkeypatch.setattr(
        detector, "detect",
        lambda text, save_run=None: calls.append(("detect", text)) or [SPAN],
    )
    monkeypatch.setattr(
        masker, "mask",
        lambda text, spans: calls.append(("mask", text, spans)) or "masked",
    )
    return calls


def test_analyze_returns_text_and_spans_without_masking(monkeypatch):
    calls = fake_steps(monkeypatch)

    result = pipeline.analyze(Path("doc.pdf"))

    assert result == pipeline.Analysis(text=TEXT, spans=[SPAN])
    assert [c[0] for c in calls] == ["extract", "detect"]


def test_anonymize_masks_detected_spans(monkeypatch):
    calls = fake_steps(monkeypatch)

    assert pipeline.anonymize(Path("doc.pdf")) == "masked"
    assert calls[-1] == ("mask", TEXT, [SPAN])


def test_cli_writes_output_file(monkeypatch, tmp_path):
    fake_steps(monkeypatch)
    out = tmp_path / "submission.txt"

    assert cli.main(["doc.pdf", "-o", str(out)]) == 0
    assert out.read_text(encoding="utf-8") == "masked"
