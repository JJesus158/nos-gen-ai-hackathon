"""Spans as the review screen sees them, following frontend/API_CONTRACT.md.

One entity per occurrence, with UTF-16 offsets into the whole text (lines
joined by "\\n"), non-overlapping, in document order. Selecting entities
and masking them again goes through mask(), so the preview, the download
and submission.txt are produced by the same code. Occurrences the user
marks by hand come back with offsets of the same kind and are masked in
that same mask() call, exactly where they are.
"""

from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from anonymizer import masker
from anonymizer.spans import Category, Span

# An occurrence marked by hand: (start, end, type), UTF-16 offsets into the
# whole text like an Entity; type is a category code or one the user made
# up ("custom:<name>").
ManualEntity = Tuple[int, int, str]


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
                  selected_ids: Iterable[str],
                  manual: Sequence[ManualEntity] = ()) -> str:
    """mask() with only the selected entities, plus the manual ones.

    Masking is span based, so identical values on the same line are
    masked together even if only one of them is selected. A manual
    occurrence is masked only where it is (see manual_ranges()).
    """
    return masker.mask(
        text, selected_spans(found, selected_ids),
        ranges=manual_ranges(text, manual),
    )


def manual_ranges(text: str,
                  manual: Sequence[ManualEntity]) -> List[masker.LineRange]:
    """The ranges mask() takes for occurrences marked by hand.

    Every word such a range touches is masked, at that position only, so
    the same value elsewhere stays visible. A taxonomy code keeps its
    Category; a category the user made up has none. ValueError if a
    range is not valid (see code_points()).
    """
    if not manual:
        return []
    utf16 = _utf16_offsets(text)
    return line_ranges(text, [
        _code_points(utf16, start, end) + (_category(kind),)
        for start, end, kind in manual
    ])


def code_points(text: str, start: int, end: int) -> Tuple[int, int]:
    """A UTF-16 range of the text, as JavaScript counts, in code points.

    ValueError unless 0 <= start < end <= the UTF-16 length of the text
    and neither offset falls inside a surrogate pair (half an emoji).
    """
    return _code_points(_utf16_offsets(text), start, end)


def line_ranges(
        text: str, ranges: Iterable[Tuple[int, int, Optional[Category]]],
) -> List[masker.LineRange]:
    """Code-point ranges of the whole text as the per-line ones of mask().

    A range running over line breaks gives one range per line it
    touches; a "\\n" is never part of one, so line breaks stay as they
    are. ValueError if a range is empty or not inside the text.
    """
    lines = text.split("\n")
    starts = _line_starts(lines)
    result: List[masker.LineRange] = []
    for start, end, category in ranges:
        if not 0 <= start < end <= len(text):
            raise ValueError(f"range {start}-{end} not in the text")
        index = bisect_right(starts, start) - 1
        while index < len(lines) and starts[index] < end:
            at = starts[index]
            first = max(start, at) - at
            last = min(end, at + len(lines[index])) - at
            if first < last:
                result.append((index, first, last, category))
            index += 1
    return result


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


def _code_points(utf16: List[int], start: int, end: int) -> Tuple[int, int]:
    """code_points() with the UTF-16 offsets of the text already known."""
    if not 0 <= start < end <= utf16[-1]:
        raise ValueError(f"range {start}-{end} not in the text")
    first, last = bisect_left(utf16, start), bisect_left(utf16, end)
    if utf16[first] != start or utf16[last] != end:
        raise ValueError(f"range {start}-{end} splits a surrogate pair")
    return first, last


def _category(kind: str) -> Optional[Category]:
    """The Category of a taxonomy code; None for one the user made up."""
    try:
        return Category(kind)
    except ValueError:
        return None


def _replacement(line: str, start: int, end: int) -> str:
    """What mask() will show for this occurrence: one * per touched word."""
    words = sum(
        1 for m in masker._WORD.finditer(line)
        if m.start() < end and m.end() > start
    )
    return " ".join([masker.MASK] * max(words, 1))


def by_id(found: Sequence[Entity]) -> Dict[str, Entity]:
    return {entity.id: entity for entity in found}
