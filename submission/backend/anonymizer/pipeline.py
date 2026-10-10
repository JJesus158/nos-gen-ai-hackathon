"""Glue between the three steps, shared by the CLI and the API."""

from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

from anonymizer import detector, extract, masker
from anonymizer.spans import Span


@dataclass(frozen=True)
class Analysis:
    """Extracted text plus the spans the LLM flagged in it."""

    text: str
    spans: List[Span]


def analyze(pdf_path: Path, save_run: Optional[Path] = None,
            from_run: Optional[Path] = None) -> Analysis:
    """Extract the text and detect sensitive spans, without masking.

    Split from masking so a reviewer can accept or reject spans first.
    `save_run` keeps the model's answer in a folder; `from_run` reuses
    one instead of calling the API.
    """
    text = extract.extract_text(pdf_path)
    if from_run is not None:
        spans = detector.detect_from_run(text, from_run)
    else:
        spans = detector.detect(text, save_run=save_run)
    return Analysis(text=text, spans=spans)


def anonymize(pdf_path: Path, save_run: Optional[Path] = None,
              from_run: Optional[Path] = None) -> str:
    """Full run with no manual review: extract, detect, mask."""
    analysis = analyze(pdf_path, save_run=save_run, from_run=from_run)
    return masker.mask(analysis.text, analysis.spans)
