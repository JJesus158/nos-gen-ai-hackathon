import {
  EDGE_PUNCTUATION,
  findOtherOccurrences,
  maskReplacement,
  overlaps,
  selectionRange,
  snapToWords,
  splitsSurrogatePair,
  textRange,
} from './manual-selection';

/** What snapToWords() keeps of the first occurrence of `selected` in `text`. */
function snapped(text: string, selected: string): string | null {
  const start = text.indexOf(selected);
  const range = snapToWords(text, start, start + selected.length);
  return range && text.slice(range.start, range.end);
}

describe('Manual selection helpers', () => {
  it('snaps a selection to the whole words it touches', () => {
    const text = 'Nome: Ana Correia, Rua da Liberdade';
    expect(snapped(text, 'orrei')).toBe('Correia');
    expect(snapped(text, 'a Co')).toBe('Ana Correia');
    expect(snapped(text, 'C')).toBe('Correia');
    expect(snapToWords(text, 0, text.length)).toEqual({ start: 0, end: text.length });
  });

  it('ignores whitespace around a selection and returns null without words', () => {
    const text = 'Nome:  Ana   Correia  \n  fim';
    expect(snapped(text, '  Ana   ')).toBe('Ana');
    expect(snapped(text, '  \n  ')).toBeNull();
    expect(snapToWords(text, 3, 3)).toBeNull();
    expect(snapToWords('Ana « Maria', 4, 5)).toBeNull();
  });

  it('leaves sentence punctuation out at both ends and keeps it inside', () => {
    const text = 'Morada: «Rua da Liberdade, 12», (Lisboa). 1000-001';
    expect(snapped(text, 'Morada:')).toBe('Morada');
    expect(snapped(text, 'Rua da Liberdade, 12»,')).toBe('Rua da Liberdade, 12');
    expect(snapped(text, '(Lisboa).')).toBe('Lisboa');
    // The comma belongs to "12»,", a word the selection touches.
    expect(snapped(text, ', (Lisb')).toBe('12», (Lisboa');
    expect(snapped(text, '000-0')).toBe('1000-001');
  });

  it('keeps the line breaks of a multi-line selection', () => {
    const text = 'Nome: Ana\nCorreia, Lisboa';
    expect(snapped(text, 'na\nCor')).toBe('Ana\nCorreia');
    expect(snapped(text, 'Ana\n')).toBe('Ana');
  });

  it('finds other whole-word occurrences with the same case outside identified data', () => {
    const text = 'Ana viu a Ana, Mariana e Ana-Maria; ana e (Ana). Ana';
    const identified = [{ start: text.lastIndexOf('Ana'), end: text.length }];
    const found = findOtherOccurrences(text, 0, 3, identified);
    expect(found).toEqual([
      { start: text.indexOf('Ana,'), end: text.indexOf('Ana,') + 3 },
      { start: text.indexOf('Ana)'), end: text.indexOf('Ana)') + 3 },
    ]);
    const lower = text.indexOf('; ana') + 2;
    expect(findOtherOccurrences(text, lower, lower + 3, [])).toEqual([]);
  });

  it('returns non-overlapping occurrences, also across lines', () => {
    expect(findOtherOccurrences('a a a a a', 0, 3, [])).toEqual([{ start: 4, end: 7 }]);
    expect(findOtherOccurrences('a a a a a', 4, 7, [])).toEqual([{ start: 0, end: 3 }]);
    const text = 'Ana\nCorreia; Contacto: Ana\nCorreia, Ana Correia';
    const other = text.indexOf('Ana\nCorreia', 1);
    expect(findOtherOccurrences(text, 0, 11, [])).toEqual([{ start: other, end: other + 11 }]);
    expect(findOtherOccurrences('Ana Ana', 2, 2, [])).toEqual([]);
  });

  it('detects overlaps and offsets inside a surrogate pair', () => {
    expect(overlaps({ start: 2, end: 4 }, [{ start: 4, end: 6 }])).toBeFalse();
    expect(overlaps({ start: 2, end: 5 }, [{ start: 4, end: 6 }])).toBeTrue();
    expect(overlaps({ start: 0, end: 9 }, [{ start: 4, end: 6 }])).toBeTrue();
    expect(overlaps({ start: 2, end: 5 }, [])).toBeFalse();
    expect([0, 1, 2, 3, 4].map((offset) => splitsSurrogatePair('a😀b', offset))).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  it('masks every word like the backend, keeping whitespace and edge punctuation', () => {
    expect(EDGE_PUNCTUATION).toBe(',.;:!?()[]{}"\'«»“”‘’');
    expect(maskReplacement('Rua da Liberdade, 12')).toBe('* * *, *');
    expect(maskReplacement('Ana\n  Correia')).toBe('*\n  *');
    expect(maskReplacement('(João), « Ana » ana@example.com 1000-001')).toBe('(*), « * » * *');
    expect(maskReplacement('“Olá!”')).toBe('“*!”');
  });

  describe('in the DOM', () => {
    let container: HTMLElement;

    beforeEach(() => {
      container = document.createElement('div');
      container.innerHTML =
        '<span>😀 Nome:</span><!-- note --> <b><i>Ana</i> Correia</b><span></span>';
      document.body.append(container);
    });

    afterEach(() => container.remove());

    it('measures UTF-16 offsets through nested elements and comment nodes', () => {
      const text = container.textContent!;
      expect(text).toBe('😀 Nome: Ana Correia');
      const range = document.createRange();
      range.setStart(container.querySelector('i')!.firstChild!, 1);
      range.setEnd(container.querySelector('b')!.lastChild!, 4);
      expect(selectionRange(container, range)).toEqual({ start: 10, end: 16 });
      expect(text.slice(10, 16)).toBe('na Cor');
      range.setStart(container, 1);
      range.setEnd(container.querySelector('b')!, 1);
      expect(selectionRange(container, range)).toEqual({ start: 8, end: 12 });
      range.setStart(container.childNodes[1], 2);
      range.setEnd(container.querySelector('i')!.firstChild!, 3);
      expect(selectionRange(container, range)).toEqual({ start: 8, end: 12 });
    });

    it('keeps only the part inside the container', () => {
      const outside = document.createElement('p');
      outside.textContent = 'antes';
      container.before(outside);
      try {
        const range = document.createRange();
        range.setStart(outside.firstChild!, 2);
        range.setEnd(container.querySelector('i')!.firstChild!, 2);
        expect(selectionRange(container, range)).toEqual({ start: 0, end: 11 });
        range.setEnd(document.body, document.body.childNodes.length);
        range.setStart(container.querySelector('b')!.lastChild!, 1);
        expect(selectionRange(container, range)).toEqual({ start: 13, end: 20 });
        range.selectNodeContents(outside);
        expect(selectionRange(container, range)).toBeNull();
        range.setStart(container.querySelector('i')!.firstChild!, 1);
        range.collapse(true);
        expect(selectionRange(container, range)).toBeNull();
        range.selectNodeContents(document.createElement('div'));
        expect(selectionRange(container, range)).toBeNull();
      } finally {
        outside.remove();
      }
    });

    it('builds the DOM range of text offsets', () => {
      const range = textRange(container, 10, 16)!;
      expect(range.toString()).toBe('na Cor');
      expect(selectionRange(container, range)).toEqual({ start: 10, end: 16 });
      expect(range.startContainer).toBe(container.querySelector('i')!.firstChild!);
      expect(textRange(container, 8, 9)!.startContainer.textContent).toBe(' ');
      expect(textRange(container, 0, 21)).toBeNull();
      expect(textRange(container, 5, 5)).toBeNull();
    });
  });
});
