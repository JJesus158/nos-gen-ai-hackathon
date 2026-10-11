import { entityPdfBoxes } from './pdf-mapping';
import type { DocumentEntity, PdfEntityBox } from './document-processor';

describe('API PDF offset mapping', () => {
  const box = (start: number, end: number, x = 10): PdfEntityBox => ({
    start, end, page: 1, x, y: 20, width: 30, height: 12,
  });
  const entity = (start: number, end: number, boxes?: PdfEntityBox[]): DocumentEntity => ({
    id: 'name', start, end, type: 'NAME', replacement: '*', boxes,
  });

  it('keeps repeated occurrences distinct by their API offsets', () => {
    const source = 'Nome: Ana; Contacto: Ana';
    expect(entityPdfBoxes(entity(6, 9, [box(6, 9)]), source)).toEqual([box(6, 9)]);
    expect(entityPdfBoxes(entity(20, 23, [box(6, 9)]), source)).toEqual([]);
    expect(entityPdfBoxes(entity(20, 23, [box(20, 23, 80)]), source)).toEqual([box(20, 23, 80)]);
  });

  it('rejects legacy first-word coordinates and incomplete multiword mappings', () => {
    const source = 'Nome: Ana Correia';
    expect(entityPdfBoxes({ ...entity(6, 17), page: 1, x: 10, y: 20, width: 30, height: 12 }, source)).toEqual([]);
    expect(entityPdfBoxes(entity(6, 17, [box(6, 9)]), source)).toEqual([]);
    expect(entityPdfBoxes(entity(6, 17, [box(6, 17)]), source)).toEqual([box(6, 17)]);
  });

  it('accepts multiple boxes separated by newlines, without spanning unrelated text', () => {
    const source = 'Rua Nova\nLisboa';
    const boxes = [box(0, 8), { ...box(9, 15), page: 2 }];
    expect(entityPdfBoxes(entity(0, 15, boxes), source)).toEqual(boxes);
    expect(entityPdfBoxes(entity(0, 15, [box(0, 3), box(9, 15)]), source)).toEqual([]);
  });

  it('uses JavaScript UTF-16 offsets, preserving accents and punctuation', () => {
    const source = '😀 João: a.b@exemplo.pt';
    const start = source.indexOf('a.b@');
    const bounds = box(start, source.length);
    expect(entityPdfBoxes(entity(start, source.length, [bounds]), source)).toEqual([bounds]);
    expect(entityPdfBoxes(entity(3, 7, [box(3, 7)]), source)).toEqual([box(3, 7)]);
  });
});
