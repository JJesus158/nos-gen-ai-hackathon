import type { DocumentEntity, PdfEntityBox } from './document-processor';

/** Only accept geometry that covers this exact API occurrence's UTF-16 range. */
export function entityPdfBoxes(entity: DocumentEntity, sourceText: string): readonly PdfEntityBox[] {
  if (!Number.isInteger(entity.start) || !Number.isInteger(entity.end) ||
      entity.start < 0 || entity.end <= entity.start || entity.end > sourceText.length ||
      !entity.boxes?.length) return [];

  const boxes = [...entity.boxes].sort((a, b) => a.start - b.start);
  let cursor = entity.start;
  for (const box of boxes) {
    if (!Number.isInteger(box.start) || !Number.isInteger(box.end) ||
        box.start < cursor || box.end <= box.start || box.end > entity.end ||
        !Number.isInteger(box.page) || box.page < 1 ||
        ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
        box.width <= 0 || box.height <= 0 ||
        sourceText.slice(cursor, box.start).trim()) return [];
    cursor = box.end;
  }
  return sourceText.slice(cursor, entity.end).trim() ? [] : boxes;
}
