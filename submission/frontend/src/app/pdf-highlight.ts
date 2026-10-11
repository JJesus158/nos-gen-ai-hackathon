import { PDFDocument, rgb } from 'pdf-lib';
import { DocumentEntity } from './document-processor';
import { entityPdfBoxes } from './pdf-mapping';

const CATEGORY_COLORS: Record<string, [number, number, number]> = {
  NAME: [0.36, 0.37, 0.78],
  ID: [0.28, 0.44, 0.71],
  CONTACT: [0.08, 0.49, 0.55],
  DOB: [0.66, 0.36, 0.19],
  FINANCIAL: [0.58, 0.39, 0.13],
  HEALTH: [0.69, 0.3, 0.38],
  SPECIAL: [0.57, 0.38, 0.64],
  PRIVATE_LIFE: [0.6, 0.41, 0.32],
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
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        color,
        opacity: 0.28,
        borderColor: color,
        borderOpacity: 0.8,
        borderWidth: 0.5,
      });
    }
  }

  const bytes = await pdf.save();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: 'application/pdf' });
}

/**
 * The protected PDF from the backend (its sensitive text is already removed)
 * with a light grey rounded box over each removed value. The asterisks stay
 * visible through the box. Never call this with the original document: the
 * boxes only decorate, they do not hide anything.
 */
export async function createBoxedPdf(
  protectedPdf: Blob,
  entities: readonly DocumentEntity[],
  sourceText: string,
): Promise<Blob> {
  const pdf = await PDFDocument.load(await protectedPdf.arrayBuffer());
  const pages = pdf.getPages();
  for (const entity of entities) {
    for (const box of entityPdfBoxes(entity, sourceText)) {
      const page = pages[box.page - 1];
      if (!page) continue;
      const width = box.width + 2 * BOX_PADDING;
      const height = box.height + 2 * BOX_PADDING;
      // drawSvgPath puts the path's origin at (x, y) with y growing down.
      page.drawSvgPath(roundedRect(width, height, Math.min(BOX_RADIUS, height / 2)), {
        x: box.x - BOX_PADDING,
        y: box.y + box.height + BOX_PADDING,
        color: rgb(0.55, 0.57, 0.62),
        opacity: 0.28,
      });
    }
  }
  const bytes = await pdf.save();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: 'application/pdf' });
}

const BOX_PADDING = 1.5;
const BOX_RADIUS = 4;

function roundedRect(width: number, height: number, radius: number): string {
  const r = radius;
  return [
    `M ${r} 0`,
    `H ${width - r}`,
    `A ${r} ${r} 0 0 1 ${width} ${r}`,
    `V ${height - r}`,
    `A ${r} ${r} 0 0 1 ${width - r} ${height}`,
    `H ${r}`,
    `A ${r} ${r} 0 0 1 0 ${height - r}`,
    `V ${r}`,
    `A ${r} ${r} 0 0 1 ${r} 0`,
    'Z',
  ].join(' ');
}
