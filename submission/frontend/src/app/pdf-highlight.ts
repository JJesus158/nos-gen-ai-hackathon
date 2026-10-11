import { PDFDocument, rgb } from 'pdf-lib';
import { DocumentEntity } from './document-processor';
import { entityPdfBoxes } from './pdf-mapping';

const CATEGORY_COLORS: Record<string, [number, number, number]> = {
  NAME: [0.36, 0.37, 0.78],
  ID: [0.28, 0.44, 0.71],
  CONTACT: [0.08, 0.49, 0.55],
  DOB: [0.66, 0.36, 0.19],
  FINANCIAL: [0.58, 0.39, 0.13],
  HEALTH: [0.69, 0.30, 0.38],
  SPECIAL: [0.57, 0.38, 0.64],
  PRIVATE_LIFE: [0.60, 0.41, 0.32],
  AGE: [0.68, 0.32, 0.43],
  OCCUPATION: [0.32, 0.46, 0.28],
  CLINICIAN: [0.03, 0.49, 0.45],
  SEX: [0.55, 0.36, 0.65],
};

/** Creates a PDF copy with selection highlights drawn in PDF coordinates. */
export async function createHighlightedPdf(
  source: Blob,
  entities: readonly DocumentEntity[],
  selectedIds: readonly string[],
  sourceText: string,
): Promise<Blob> {
  const pdf = await PDFDocument.load(await source.arrayBuffer());
  const selected = new Set(selectedIds);

  for (const entity of entities) {
    if (!selected.has(entity.id)) continue;
    const boxes = entityPdfBoxes(entity, sourceText);
    if (!boxes.length) throw new Error('Missing PDF geometry for an API entity range');
    const [red, green, blue] = CATEGORY_COLORS[entity.type] ?? [0.5, 0.5, 0.5];
    const color = rgb(red, green, blue);

    for (const box of boxes) {
      const page = pdf.getPages()[box.page - 1];
      if (!page) throw new Error('PDF entity page is outside the document');
      page.drawRectangle({
        x: box.x, y: box.y, width: box.width, height: box.height,
        color, opacity: 0.28, borderColor: color, borderOpacity: 0.8, borderWidth: 0.5,
      });
    }
  }

  const bytes = await pdf.save();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: 'application/pdf' });
}

/** Creates a display-only protected PDF; sensitive areas are fully covered. */
export async function createBlurredPreviewPdf(
  source: Blob,
  entities: readonly DocumentEntity[],
  sourceText: string,
): Promise<Blob> {
  const pdf = await PDFDocument.load(await source.arrayBuffer());
  for (const entity of entities) {
    for (const box of entityPdfBoxes(entity, sourceText)) {
      const page = pdf.getPages()[box.page - 1];
      if (!page) continue;
      page.drawRectangle({
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        color: rgb(1, 1, 1),
        // Keep the source visible underneath the CSS backdrop blur. The PDF
        // preview hides a newly rendered page until its overlays are ready,
        // so the source never flashes during a mode change.
        opacity: 0.08,
      });
    }
  }
  const bytes = await pdf.save();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: 'application/pdf' });
}
