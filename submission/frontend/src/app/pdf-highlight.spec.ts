import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, StandardFonts } from 'pdf-lib';
import { createBoxedPdf } from './pdf-highlight';
import type { DocumentEntity } from './document-processor';

describe('grey boxes on the protected PDF', () => {
  const text = 'Nome: Ana';

  async function protectedPdf(): Promise<Blob> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([300, 200]).drawText('Nome: *', { x: 20, y: 150, size: 12, font });
    return new Blob([new Uint8Array(await pdf.save())], { type: 'application/pdf' });
  }

  function ana(withBoxes: boolean): DocumentEntity {
    const box = { start: 6, end: 9, page: 1, x: 56, y: 147, width: 22, height: 13 };
    return {
      id: 'name-1',
      start: 6,
      end: 9,
      type: 'NAME',
      replacement: '*',
      ...(withBoxes ? { boxes: [box] } : {}),
    };
  }

  async function firstPage(blob: Blob) {
    return (await PDFDocument.load(await blob.arrayBuffer())).getPage(0);
  }

  /** Fill opacities of the page's graphics states. */
  function opacities(page: Awaited<ReturnType<typeof firstPage>>): number[] {
    const states = page.node.Resources()!.lookup(PDFName.of('ExtGState'));
    if (!(states instanceof PDFDict)) return [];
    return states
      .values()
      .map((ref) => page.doc.context.lookup(ref, PDFDict).get(PDFName.of('ca')))
      .filter((value): value is PDFNumber => value instanceof PDFNumber)
      .map((value) => value.asNumber());
  }

  it('draws a translucent box over each removed value', async () => {
    const boxed = await createBoxedPdf(await protectedPdf(), [ana(true)], text);

    expect(boxed.type).toBe('application/pdf');
    const page = await firstPage(boxed);
    expect(page.node.Contents() instanceof PDFArray).toBeTrue();
    // Translucent, so the asterisks stay readable through the box.
    expect(opacities(page)).toContain(0.28);
  });

  it('leaves the page as it is when a value has no PDF geometry', async () => {
    const boxed = await createBoxedPdf(await protectedPdf(), [ana(false)], text);

    expect(opacities(await firstPage(boxed))).not.toContain(0.28);
  });
});
