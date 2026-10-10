"""Spans as the review screen sees them, following frontend/API_CONTRACT.md.

One entity per occurrence, with UTF-16 offsets into the whole text (lines
joined by "\\n"), non-overlapping, in document order. Selecting entities
and masking them again goes through mask(), so the preview, the download
and submission.txt are produced by the same code.
"""

from dataclasses import dataclass
from typing import Dict, Iterable, List, Sequence

from anonymizer import masker
from anonymizer.spans import Span


@dataclass(frozen=True)
class Entity:
    id: str
    start: int
    end: int
    type: str
    replacement: str
    reason: str
    span: Span


def entities(text: str, spans: Sequence[Span]) -> List[Entity]:
    """Every occurrence of every span, as the contract wants it.

    Overlapping occurrences keep the longest one; duplicates (two spans
    for the same text on the same line) keep the first. Offsets are
    UTF-16 code units, as JavaScript counts them.
    """
    lines = text.split("\n")
    line_start = _line_starts(lines)
    found = []
    for span in spans:
        for index, start, end in masker._find(lines, span):
            at = line_start[index]
            found.append((at + start, at + end, index, start, end, span))
    found.sort(key=lambda f: (f[0], -f[1]))

    utf16 = _utf16_offsets(text)
    result: List[Entity] = []
    last_end = 0
    for start, end, index, line_from, line_to, span in found:
        if start < last_end:
            continue
        last_end = end
        result.append(Entity(
            id=f"entity-{len(result) + 1}",
            start=utf16[start],
            end=utf16[end],
            type=span.category.value,
            replacement=_replacement(lines[index], line_from, line_to),
            reason=span.reason,
            span=span,
        ))
    return result


def selected_spans(found: Iterable[Entity],
                   selected_ids: Iterable[str]) -> List[Span]:
    """The spans behind the selected entities, each once, in order."""
    wanted = set(selected_ids)
    spans: List[Span] = []
    for entity in found:
        if entity.id in wanted and entity.span not in spans:
            spans.append(entity.span)
    return spans


def mask_selected(text: str, found: Iterable[Entity],
                  selected_ids: Iterable[str]) -> str:
    """mask() with only the selected entities.

    Masking is span based, so identical values on the same line are
    masked together even if only one of them is selected.
    """
    return masker.mask(text, selected_spans(found, selected_ids))


def _line_starts(lines: Sequence[str]) -> List[int]:
    starts, offset = [], 0
    for line in lines:
        starts.append(offset)
        offset += len(line) + 1
    return starts


def _utf16_offsets(text: str) -> List[int]:
    """UTF-16 offset of every code-point index, plus the end."""
    offsets, units = [], 0
    for char in text:
        offsets.append(units)
        units += 2 if ord(char) > 0xFFFF else 1
    offsets.append(units)
    return offsets


def _replacement(line: str, start: int, end: int) -> str:
    """What mask() will show for this occurrence: one * per touched word."""
    words = sum(
        1 for m in masker._WORD.finditer(line)
        if m.start() < end and m.end() > start
    )
    return " ".join([masker.MASK] * max(words, 1))


def by_id(found: Sequence[Entity]) -> Dict[str, Entity]:
    return {entity.id: entity for entity in found}
