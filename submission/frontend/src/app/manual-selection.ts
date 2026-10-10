/** UTF-16 offsets in a text; start is inclusive and end is exclusive. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** Sentence punctuation kept around a masked word: the same set as the backend masker. */
export const EDGE_PUNCTUATION = ',.;:!?()[]{}"\'«»“”‘’';

const MASK = '*';

/**
 * Offsets of the part of `range` that lies inside `container`, in the text of the container.
 * Range.toString() only counts Text nodes, so elements and comments at any depth do not matter.
 * Null when the range does not intersect the container or the intersection has no text.
 */
export function selectionRange(container: Node, range: Range): TextRange | null {
  const document = container.ownerDocument;
  if (!document) return null;
  const contents = document.createRange();
  contents.selectNodeContents(container);
  const offset = (node: Node, position: number): number => {
    const comparison = contents.comparePoint(node, position);
    if (comparison < 0) return 0;
    if (comparison > 0) return contents.toString().length;
    const before = document.createRange();
    before.setStart(container, 0);
    before.setEnd(node, position);
    return before.toString().length;
  };
  try {
    const start = offset(range.startContainer, range.startOffset);
    const end = offset(range.endContainer, range.endOffset);
    return end > start ? { start, end } : null;
  } catch {
    // The range belongs to another tree.
    return null;
  }
}

/** A DOM Range over text offsets of `container`: the inverse of selectionRange(). */
export function textRange(container: Node, start: number, end: number): Range | null {
  const document = container.ownerDocument;
  if (!document || !(start >= 0 && end > start)) return null;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node as Text).length;
    // Start in the node holding the first character, not at the end of the previous one.
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

/**
 * Expands a selection to whole words (maximal runs of non-whitespace), then leaves the sentence
 * punctuation at both ends out. The backend masks every word a range touches, so the snapped range
 * is exactly what will be masked. Whitespace around the selection is ignored; null when only
 * whitespace or punctuation is selected.
 */
export function snapToWords(text: string, start: number, end: number): TextRange | null {
  let from = Math.max(0, Math.min(start, text.length));
  let to = Math.max(from, Math.min(end, text.length));
  while (from < to && isSpace(text[from])) from++;
  while (to > from && isSpace(text[to - 1])) to--;
  if (from === to) return null;
  while (from > 0 && !isSpace(text[from - 1])) from--;
  while (to < text.length && !isSpace(text[to])) to++;
  // Spaces too: a token made only of punctuation leaves the one before or after the next word.
  while (from < to && isEdge(text[from])) from++;
  while (to > from && isEdge(text[to - 1])) to--;
  return from < to ? { start: from, end: to } : null;
}

/**
 * Other occurrences of exactly the same text, case-sensitive and non-overlapping, that are whole
 * words: snapToWords() keeps them as they are, so the character before and after is not a letter
 * or digit and "Ana" is found neither in "Mariana" nor in "Ana-Maria" (the backend would mask the
 * whole "Ana-Maria"). Occurrences overlapping the original range or an entity are left out.
 */
export function findOtherOccurrences(
  text: string,
  start: number,
  end: number,
  entities: readonly TextRange[],
): TextRange[] {
  const value = text.slice(start, end);
  const found: TextRange[] = [];
  if (!value) return found;
  const original = [{ start, end }];
  let index = text.indexOf(value);
  while (index >= 0) {
    const range = { start: index, end: index + value.length };
    const snapped = snapToWords(text, range.start, range.end);
    if (
      snapped?.start === range.start &&
      snapped.end === range.end &&
      !overlaps(range, original) &&
      !overlaps(range, entities)
    ) {
      found.push(range);
      index = text.indexOf(value, range.end);
    } else {
      index = text.indexOf(value, index + 1);
    }
  }
  return found;
}

/** Whether `range` shares at least one character with any of `ranges`. */
export function overlaps(range: TextRange, ranges: readonly TextRange[]): boolean {
  return ranges.some((other) => other.start < range.end && range.start < other.end);
}

/** Whether a UTF-16 offset falls between the two halves of a surrogate pair. */
export function splitsSurrogatePair(text: string, offset: number): boolean {
  return (
    /[\uD800-\uDBFF]/.test(text.charAt(offset - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(offset))
  );
}

/**
 * Local stand-in for backend masking: every whitespace-separated word becomes one "*", keeping
 * whitespace, line breaks and the sentence punctuation at word edges; a token made only of
 * punctuation stays as it is. "Rua da Liberdade, 12" becomes "* * *, *".
 */
export function maskReplacement(value: string): string {
  return value.replace(/\S+/g, (word) => {
    let start = 0;
    let end = word.length;
    while (start < end && EDGE_PUNCTUATION.includes(word[start])) start++;
    while (end > start && EDGE_PUNCTUATION.includes(word[end - 1])) end--;
    return start === end ? word : word.slice(0, start) + MASK + word.slice(end);
  });
}

function isSpace(character: string): boolean {
  return /\s/.test(character);
}

function isEdge(character: string): boolean {
  return isSpace(character) || EDGE_PUNCTUATION.includes(character);
}
