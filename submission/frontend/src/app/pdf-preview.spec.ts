import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PdfPreview } from './pdf-preview';
import { createHighlightedPdf } from './pdf-highlight';
import type { DocumentEntity, PdfEntityBox } from './document-processor';

describe('PDF preview with API offset geometry', () => {
  const text = 'Nome: Ana; Contacto: Ana\nNome: Ana';
  let fixture: ComponentFixture<PdfPreview>;
  let file: Blob;
  let entities: DocumentEntity[];
  let scroll: HTMLDivElement;

  beforeEach(async () => {
    TestBed.configureTestingModule({ imports: [PdfPreview] });
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([300, 220]).drawText('Nome: Ana; Contacto: Ana', { x: 30, y: 160, size: 12, font });
    pdf.addPage([300, 220]).drawText('Nome: Ana', { x: 30, y: 160, size: 12, font });
    file = new Blob([new Uint8Array(await pdf.save())], { type: 'application/pdf' });
    const box = (start: number, page: number, prefix: string): PdfEntityBox => ({
      start,
      end: start + 3,
      page,
      x: 30 + font.widthOfTextAtSize(prefix, 12),
      y: 157,
      width: font.widthOfTextAtSize('Ana', 12),
      height: 16,
    });
    entities = [box(6, 1, 'Nome: '), box(20, 1, 'Nome: Ana; Contacto: '), box(30, 2, 'Nome: ')].map(
      (bounds, i) => ({
        id: 'name-' + i,
        type: 'NAME',
        start: bounds.start,
        end: bounds.end,
        replacement: '*',
        boxes: [bounds],
        // Obsolete coordinates must never take precedence over API ranges.
        page: 1,
        x: 0,
        y: 0,
        width: 300,
        height: 220,
      }),
    );
    fixture = TestBed.createComponent(PdfPreview);
    scroll = document.createElement('div');
    scroll.className = 'paper-scroll';
    scroll.style.cssText = 'width:400px;height:200px;overflow:auto;';
    document.body.append(scroll);
    scroll.append(fixture.nativeElement);
    fixture.componentRef.setInput('fullSize', true);
    fixture.componentRef.setInput('showControls', false);
  });

  afterEach(() => {
    fixture.destroy();
    scroll.remove();
  });

  async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 8000;
    while (!predicate() && Date.now() < deadline) {
      fixture.detectChanges();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    fixture.detectChanges();
    expect(predicate()).withContext(fixture.nativeElement.textContent).toBeTrue();
  }

  function canvas(page: number): HTMLCanvasElement {
    return fixture.nativeElement.querySelector('[data-page="' + page + '"] canvas');
  }

  function pixel(bounds: PdfEntityBox): number[] {
    const element = canvas(bounds.page);
    const scale = element.width / 300;
    // Sample above the letters, inside the highlight rectangle.
    return Array.from(
      element
        .getContext('2d')!
        .getImageData(
          Math.round((bounds.x + bounds.width / 2) * scale),
          Math.round((220 - bounds.y - bounds.height + 2) * scale),
          1,
          1,
        ).data,
    );
  }

  it('renders only the selected repeated occurrence, including on page two', async () => {
    fixture.componentRef.setInput(
      'file',
      await createHighlightedPdf(file, entities, ['name-1', 'name-2'], text),
    );
    fixture.detectChanges();
    await waitFor(() => !!canvas(2));
    expect(pixel(entities[0].boxes![0])).toEqual([255, 255, 255, 255]);
    expect(pixel(entities[1].boxes![0])).not.toEqual([255, 255, 255, 255]);
    expect(pixel(entities[2].boxes![0])).not.toEqual([255, 255, 255, 255]);
    // No duplicate heuristic overlay is added to the edited PDF.
    expect(fixture.nativeElement.querySelectorAll('.pdf-highlight').length).toBe(0);
  });

  it('keeps the previous canvas and scroll position while selection updates', async () => {
    fixture.componentRef.setInput(
      'file',
      await createHighlightedPdf(file, entities, ['name-1'], text),
    );
    fixture.detectChanges();
    await waitFor(() => !!canvas(2));
    scroll.scrollTop = 130;
    const previous = canvas(1);
    fixture.componentRef.setInput('file', await createHighlightedPdf(file, entities, [], text));
    fixture.detectChanges();
    expect(canvas(1)).toBe(previous);
    expect(fixture.nativeElement.querySelector('.pdf-pages').hidden).toBeFalse();
    await waitFor(() => canvas(1) !== previous);
    expect(scroll.scrollTop).toBe(130);
    expect(pixel(entities[1].boxes![0])).toEqual([255, 255, 255, 255]);
  });

  it('uses exact boxes for blur and updates overlays without rerendering the document', async () => {
    fixture.componentRef.setInput('file', file);
    fixture.componentRef.setInput('sourceText', text);
    fixture.componentRef.setInput('highlights', [entities[1]]);
    fixture.componentRef.setInput('maskMode', 'blur');
    fixture.detectChanges();
    await waitFor(() => !!fixture.nativeElement.querySelector('.pdf-highlight'));
    const mark = fixture.nativeElement.querySelector('.pdf-highlight') as HTMLElement;
    expect(mark.dataset['entityId']).toBe('name-1');
    const scale = canvas(1).width / 300;
    expect(parseFloat(mark.style.width)).toBeCloseTo(entities[1].boxes![0].width * scale, 1);
    const previous = canvas(1);
    fixture.componentRef.setInput('highlights', []);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pdf-highlight')).toBeNull();
    expect(canvas(1)).toBe(previous);
  });
});
