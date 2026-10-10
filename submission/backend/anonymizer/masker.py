"""Deterministic masking. Owner: feature/anonymization.

Input: the spans of the LLM output, {"spans": [{"line", "text",
"category", "reason"}]}, as Span objects. Only that output is used, never
the prompt, so the prompt can change freely. Each span is found in its
line, every word it touches becomes a single "*", and lines, spacing and
every other word stay byte for byte the same. How a "*" is finally shown
(as is, blurred, a random value...) is up to the client, which can locate
every "*" through mask_with_positions().
"""

import re
from dataclasses import dataclass
from typing import Dict, List, Sequence, Tuple

from anonymizer.spans import Category, Span

MASK = "*"

# Sentence punctuation around a word is kept, so "(João," becomes "(*,".
EDGE_PUNCTUATION = ",.;:!?()[]{}\"'«»“”‘’"

_WORD = re.compile(r"\S+")

# Letters, digits and the accents of decomposed text ("e" + U+0301).
_WORD_CHAR = r"[\ẁ-ͯ]"


@dataclass(frozen=True)
class MaskedWord:
    """One "*" and the word it replaced (line is 1-based).

    column: where the "*" sits in the masked line.
    index: position of the word in the line, counting words separated by
        whitespace from 0; the same numbering PyMuPDF gives to the words
        of a PDF line, so it links a "*" to a box in the PDF.
    start, end: the word in the original line, as line[start:end],
        including any punctuation around it ("(João,").
    word: that original text.
    """

    line: int
    column: int
    category: Category
    index: int
    start: int
    end: int
    word: str


@dataclass(frozen=True)
class Run:
    """Masked words that follow each other on one line.

    Drawing one box from the first word to the last keeps consecutive
    "*" together instead of leaving a gap the width of each word.
    """

    line: int
    first: int
    last: int
    words: List[MaskedWord]

    @property
    def categories(self) -> List[Category]:
        return [w.category for w in self.words]


@dataclass(frozen=True)
class MaskResult:
    """The masked text, every "*" put in it, and the spans not found."""

    text: str
    words: List[MaskedWord]
    unmatched: List[Span]


def mask(text: str, spans: Sequence[Span],
         keep_punctuation: bool = True) -> str:
    """Replace every word touched by a span with a single "*".

    "Ana Correia" becomes "* *". The number of lines and words must not
    change, and words outside the spans must stay byte for byte the same.
    With keep_punctuation=False, "Santos," becomes "*" instead of "*,".
    A token made only of punctuation, such as a lone "«", is not a word
    and stays as it is.
    """
    return mask_with_positions(text, spans, keep_punctuation).text


def mask_with_positions(text: str, spans: Sequence[Span],
                        keep_punctuation: bool = True) -> MaskResult:
    """Same as mask(), plus the position and category of every "*"."""
    lines = text.split("\n")
    hits: Dict[int, List[Tuple[int, int, Category]]] = {}
    unmatched = []
    for span in spans:
        found = _find(lines, span)
        if not found:
            unmatched.append(span)
        for index, start, end in found:
            hits.setdefault(index, []).append((start, end, span.category))

    words: List[MaskedWord] = []
    for index in sorted(hits):
        lines[index] = _mask_line(
            lines[index], index + 1, hits[index], keep_punctuation, words,
        )
    return MaskResult("\n".join(lines), words, unmatched)


def runs(words: Sequence[MaskedWord]) -> List[Run]:
    """Group masked words with consecutive indexes on the same line.

    "A paciente * *, mulher * de * anos" gives three runs: the two words
    of the name, then one run for each lone "*". Runs never cross lines.
    """
    result: List[Run] = []
    for word in sorted(words, key=lambda w: (w.line, w.index)):
        last = result[-1] if result else None
        if last and last.line == word.line and last.last + 1 == word.index:
            result[-1] = Run(
                last.line, last.first, word.index, last.words + [word],
            )
        else:
            result.append(Run(word.line, word.index, word.index, [word]))
    return result


def _find(lines: List[str], span: Span) -> List[Tuple[int, int, int]]:
    """(line index, start, end) of every occurrence of the span.

    Tries, in order:
    1. whole words in the span's own line;
    2. whole words running over a line break (that line joined with the
       next one or with the previous one);
    3. part of a word in its own line, since a span may point at "72"
       inside "72kg": first at the start of a word, then anywhere. The
       whole word that contains it is masked. Needs two characters at
       least, so a stray letter never masks half a line.
    """
    text = " ".join(span.text.split()).strip(EDGE_PUNCTUATION + " ")
    words = text.split()
    index = span.line - 1
    if not words or not 0 <= index < len(lines):
        return []
    pattern = _pattern(words)
    found = _in_line(lines, index, pattern)
    if found:
        return found
    for first in (index, index - 1):
        if 0 <= first < len(lines) - 1:
            found += _across_break(lines, first, pattern)
    if found or len(text) < 2:
        return found
    for word_start in (True, False):
        found = _in_line(lines, index, _pattern(words, word_start, False))
        if found:
            break
    return found


def _pattern(words: Sequence[str], word_start: bool = True,
             word_end: bool = True) -> re.Pattern:
    """Every occurrence of the words in order.

    With word_start/word_end the text must start/end on a word boundary,
    so "2" never matches inside "12". Any whitespace may separate the
    words, so a name still matches when the PDF put two spaces or a line
    break between them. The pattern is a lookahead, so overlapping
    occurrences ("912 912" in "912 912 912") are all found: read each
    one with match.span(1).
    """
    body = r"\s+".join(re.escape(word) for word in words)
    if word_start and re.match(_WORD_CHAR, words[0]):
        body = "(?<!" + _WORD_CHAR + ")" + body
    if word_end and re.search(_WORD_CHAR + "$", words[-1]):
        body += "(?!" + _WORD_CHAR + ")"
    return re.compile("(?=(" + body + "))")


def _in_line(lines: List[str], index: int,
             pattern: re.Pattern) -> List[Tuple[int, int, int]]:
    """Every occurrence of the pattern in one line."""
    return [(index,) + m.span(1) for m in pattern.finditer(lines[index])]


def _across_break(lines: List[str], first: int,
                  pattern: re.Pattern) -> List[Tuple[int, int, int]]:
    """Occurrences that start on line `first` and end on the next one."""
    cut = len(lines[first])
    joined = lines[first] + "\n" + lines[first + 1]
    found = []
    for match in pattern.finditer(joined):
        start, end = match.span(1)
        if start < cut < end:
            found += [(first, start, cut), (first + 1, 0, end - cut - 1)]
    return found


def _mask_line(line: str, number: int,
               hits: List[Tuple[int, int, Category]],
               keep_punctuation: bool, words: List[MaskedWord]) -> str:
    """Turn every word of the line that a hit touches into a "*"."""
    out = []
    length = 0
    done = 0
    for index, match in enumerate(_WORD.finditer(line)):
        word_start, word_end = match.span()
        touching = [
            cat for lo, hi, cat in hits
            if lo < word_end and hi > word_start
        ]
        if not touching:
            continue
        start, end = word_start, word_end
        if keep_punctuation:
            start, end = _trim(line, start, end)
        if start == end:
            continue
        gap = line[done:start]
        out += [gap, MASK]
        words.append(MaskedWord(
            number, length + len(gap), touching[0],
            index, word_start, word_end, match.group(),
        ))
        length += len(gap) + len(MASK)
        done = end
    out.append(line[done:])
    return "".join(out)


def _trim(line: str, start: int, end: int) -> Tuple[int, int]:
    """Leave the sentence punctuation around a word out of the mask."""
    while start < end and line[start] in EDGE_PUNCTUATION:
        start += 1
    while end > start and line[end - 1] in EDGE_PUNCTUATION:
        end -= 1
    return start, end
