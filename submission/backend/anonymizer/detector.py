"""LLM detection of sensitive data. Owner: feature/gemini-detection."""

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from pydantic import BaseModel

from anonymizer import gemini_client
from anonymizer.spans import Category, Span

PROMPT_PATH = Path(__file__).resolve().parents[2] / "prompt.txt"
PLACEHOLDER = "{{DOCUMENT}}"
RUN_SPANS = "spans.json"
RUN_INFO = "run.json"


class DetectedSpan(BaseModel):
    line: int
    text: str
    category: Category
    reason: str


class Detection(BaseModel):
    spans: List[DetectedSpan]


def number_lines(text: str) -> str:
    """Prefix each line with "L001| " so the LLM can point at lines."""
    return "\n".join(
        f"L{i:03d}| {line}"
        for i, line in enumerate(text.split("\n"), start=1)
    )


def build_prompt(text: str) -> str:
    """prompt.txt with the numbered document in place of the placeholder."""
    template = PROMPT_PATH.read_text(encoding="utf-8")
    return template.replace(PLACEHOLDER, number_lines(text))


Piece = Tuple[int, str]


def _pieces(text: str, lines: List[str], hint: int) -> List[Piece]:
    """Where `text` is in the document, as (line, exact text) per line.

    Uses the first kind of match found, nearest to the LLM's `hint`:
    1. whole words inside one line;
    2. whole words split by a line break (#4): one piece per line;
    3. part of a word, e.g. "72" in "72kg" (mask() masks the whole word):
       at least two characters, start of a word before anywhere (#9).
    Any whitespace between the words of `text` is accepted. Text found
    nowhere stays on the hinted line, so mask() reports it as unmatched
    instead of it being lost silently.
    """
    body = r"\s+".join(re.escape(word) for word in text.split())
    whole = re.compile(r"(?<!\w)" + body + r"(?!\w)")

    def nearest(found: Dict[int, List[Piece]]) -> List[Piece]:
        return found[min(found, key=lambda i: abs(i - hint))]

    same_line = {}
    for i, line in enumerate(lines, 1):
        match = whole.search(line)
        if match:
            same_line[i] = [(i, match.group())]
    if same_line:
        return nearest(same_line)

    split = {}
    for i in range(1, len(lines)):
        joined = lines[i - 1] + "\n" + lines[i]
        match = whole.search(joined)
        if match:
            cut = len(lines[i - 1])
            split[i] = [
                (i, joined[match.start():cut].strip()),
                (i + 1, joined[cut + 1:match.end()].strip()),
            ]
    if split:
        return nearest(split)

    # Part of a word (#9): same order as the masker. At least two
    # characters, first at the start of a word ("50" in "50mg", not in
    # "1500mg"), then anywhere ("123" in "ABC123XYZ").
    if len(text) >= 2:
        for part in (re.compile(r"(?<!\w)" + body), re.compile(body)):
            glued = {}
            for i, line in enumerate(lines, 1):
                match = part.search(line)
                if match:
                    glued[i] = [(i, match.group())]
            if glued:
                return nearest(glued)

    return [(min(max(hint, 1), len(lines)), text)]


def _locate(found: List[DetectedSpan], lines: List[str]) -> List[Span]:
    """Turn the LLM's answer into spans that each sit on one line."""
    spans = []
    seen = set()
    for item in found:
        if not item.text.strip():
            continue
        for line, text in _pieces(item.text, lines, item.line):
            key = (line, text, item.category)
            if key in seen:
                continue
            seen.add(key)
            spans.append(Span(line, text, item.category, item.reason))
    return spans


def detect(text: str, save_run: Optional[Path] = None) -> List[Span]:
    """Ask Gemini which parts of the text are sensitive.

    The LLM only points at spans; it never rewrites the document, so the
    formatting cannot drift. With `save_run`, the model's answer and the
    run details are written to that folder (see save_run()), so the run
    can be shown and replayed without the API.
    """
    prompt = build_prompt(text)
    detection, raw = gemini_client.generate_json_raw(prompt, Detection)
    if save_run is not None:
        _save_run(save_run, raw, prompt, text)
    return _locate(detection.spans, text.split("\n"))


def detect_from_run(text: str, run_dir: Path) -> List[Span]:
    """Reuse the answer saved by detect(save_run=...) instead of the API."""
    raw = (run_dir / RUN_SPANS).read_text(encoding="utf-8")
    return _locate(Detection.model_validate_json(raw).spans, text.split("\n"))


def _save_run(run_dir: Path, raw: str, prompt: str, text: str) -> None:
    """spans.json = the answer as returned; run.json = what produced it."""
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / RUN_SPANS).write_text(raw, encoding="utf-8")
    info = {
        "model": gemini_client.get_model(),
        "prompt_file": PROMPT_PATH.name,
        "prompt_sha256": _sha256(prompt),
        "document_sha256": _sha256(text),
        "document_lines": text.count("\n") + 1,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (run_dir / RUN_INFO).write_text(
        json.dumps(info, indent=2) + "\n", encoding="utf-8",
    )


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
