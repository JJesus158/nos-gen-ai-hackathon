import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { faFilePdf } from '@fortawesome/free-solid-svg-icons';
import type { PDFDocumentLoadingTask, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { LanguageService } from './language.service';
import type { DocumentEntity } from './document-processor';
import { categoryDetails } from './document-categories';
import { entityPdfBoxes } from './pdf-mapping';

interface RenderedPage {
  readonly page: number;
  readonly viewport: ReturnType<PDFPageProxy['getViewport']>;
  readonly overlay: HTMLDivElement;
}

@Component({
  selector: 'app-pdf-preview',
  templateUrl: './pdf-preview.html',
  styleUrl: './pdf-preview.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PdfPreview {
  /** Null until the parent has a file: nothing is rendered and nothing is reported. */
  readonly file = input<Blob | null>(null);
  /** The file could not be rendered as a PDF; the parent may show its text instead. */
  readonly unavailable = output<void>();
  readonly fullSize = input(false);
  readonly highlights = input<readonly DocumentEntity[]>([]);
  readonly sourceText = input('');
  readonly zoomLevel = input(1);
  readonly fit = input<'width' | 'height'>('width');
  readonly showControls = input(true);
  readonly maskMode = input<'highlight' | 'blur'>('highlight');
  protected readonly zoom = signal(1);
  protected readonly language = inject(LanguageService);
  protected readonly icon = faFilePdf;
  protected readonly state = signal<'loading' | 'ready' | 'unavailable'>('loading');
  protected readonly rendered = signal(false);
  private readonly document = inject(DOCUMENT);
  private readonly pages = viewChild<ElementRef<HTMLDivElement>>('pages');
  private readonly containerSize = signal({ width: 0, height: 0 });
  private readonly renderedPages = signal<readonly RenderedPage[]>([]);

  constructor() {
    effect((onCleanup) => {
      const file = this.file();
      const container = this.pages()?.nativeElement;
      const fullSize = this.fullSize();
      const zoom = this.zoomLevel() * this.zoom();
      const fit = this.fit();
      const measuredSize = this.containerSize();
      if (!container || !file) return;

      let cancelled = false;
      let loading: PDFDocumentLoadingTask | undefined;
      let rendering: RenderTask | undefined;
      let resizeFrame: number | undefined;
      const scrollViewport = container.closest<HTMLElement>('.paper-scroll');
      const resizeTarget = scrollViewport ?? container.parentElement;
      const resizeObserver = fullSize && resizeTarget && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(([entry]) => {
          if (!entry) return;
          const width = Math.max(1, Math.round(resizeTarget.clientWidth || entry.contentRect.width));
          const height = Math.max(1, Math.round(resizeTarget.clientHeight || entry.contentRect.height));
          const current = this.containerSize();
          if (width === current.width && height === current.height) return;
          if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
          resizeFrame = requestAnimationFrame(() => this.containerSize.set({ width, height }));
        })
        : undefined;
      if (resizeTarget) resizeObserver?.observe(resizeTarget);
      const release = () => {
        const task = loading;
        loading = undefined;
        if (task) void task.destroy().catch(() => {});
      };
      onCleanup(() => {
        cancelled = true;
        rendering?.cancel();
        resizeObserver?.disconnect();
        if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
        release();
      });
      this.state.set('loading');
      // Keep the already-rendered (and already masked) pages visible while
      // the replacement PDF is prepared. New pages are hidden individually
      // until their masking/highlight overlays are installed.
      this.renderedPages.set([]);

      const render = async () => {
        try {
          const [pdf, data] = await Promise.all([import('pdfjs-dist'), file.arrayBuffer()]);
          if (cancelled) return;
          pdf.GlobalWorkerOptions.workerSrc = new URL(
            'pdf.worker.min.mjs',
            this.document.baseURI,
          ).href;
          loading = pdf.getDocument({ data: new Uint8Array(data) });
          const document = await loading.promise;
          if (cancelled) return;
          const fragment = this.document.createDocumentFragment();
          const renderedPages: RenderedPage[] = [];
          const pageCount = fullSize ? document.numPages : 1;

          for (let number = 1; number <= pageCount; number++) {
            const page = await document.getPage(number);
            if (cancelled) return;
            const original = page.getViewport({ scale: 1 });
            const availableWidth = Math.max(
              1,
              measuredSize.width || scrollViewport?.clientWidth || container.parentElement?.clientWidth || 900,
            );
            const availableHeight = Math.max(
              1,
              measuredSize.height || scrollViewport?.clientHeight || container.parentElement?.clientHeight || 700,
            );
            const scale = fullSize
              ? ((fit === 'height'
                ? availableHeight / original.height
                : availableWidth / original.width) * zoom)
              : Math.min(80 / original.width, 100 / original.height);
            const viewport = page.getViewport({ scale });
            const canvas = this.document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            canvas.style.display = 'block';
            canvas.style.background = 'white';
            canvas.setAttribute('role', 'img');
            canvas.setAttribute('aria-label', 'PDF ' + number + ' / ' + document.numPages);
            rendering = page.render({ canvas, viewport });
            await rendering.promise;
            if (cancelled) return;

            const wrapper = this.document.createElement('div');
            wrapper.className = 'pdf-canvas-wrap';
            wrapper.dataset['page'] = String(number);
            wrapper.style.cssText = 'position:relative;width:fit-content;flex-shrink:0;opacity:0;';
            const overlay = this.document.createElement('div');
            overlay.className = 'pdf-overlay';
            overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
            overlay.setAttribute('aria-hidden', 'true');
            wrapper.append(canvas, overlay);
            fragment.append(wrapper);
            renderedPages.push({ page: number, viewport, overlay });
          }

          // Keep old pages visible until replacements are ready, preserving scroll.
          if (cancelled) return;
          container.replaceChildren(fragment);
          this.renderedPages.set(renderedPages);
          this.rendered.set(true);
          this.state.set('ready');
        } catch {
          if (!cancelled) {
            this.state.set('unavailable');
            this.unavailable.emit();
          }
        } finally {
          release();
        }
      };
      void render();
    });

    effect(() => {
      const pages = this.renderedPages();
      const sourceText = this.sourceText();
      const highlights = this.highlights();
      const maskMode = this.maskMode();
      for (const { page, viewport, overlay } of pages) {
        const fragment = this.document.createDocumentFragment();
        for (const entity of highlights) {
          for (const box of entityPdfBoxes(entity, sourceText)) {
            if (box.page !== page) continue;
            const [x0, y0] = viewport.convertToViewportPoint(box.x, box.y);
            const [x1, y1] = viewport.convertToViewportPoint(box.x + box.width, box.y + box.height);
            const mark = this.document.createElement('span');
            mark.className = 'pdf-highlight';
            mark.dataset['entityId'] = entity.id;
            mark.style.position = 'absolute';
            mark.style.left = Math.min(x0, x1) + 'px';
            mark.style.top = Math.min(y0, y1) + 'px';
            mark.style.width = Math.abs(x1 - x0) + 'px';
            mark.style.height = Math.abs(y1 - y0) + 'px';
            if (maskMode === 'blur') {
              mark.style.zIndex = '3';
              mark.style.background = 'rgb(255 255 255 / 28%)';
              mark.style.backdropFilter = 'blur(7px)';
              mark.style.setProperty('-webkit-backdrop-filter', 'blur(7px)');
              mark.style.borderRadius = '2px';
            } else {
              const color = categoryDetails(entity.type).color;
              mark.style.background = 'color-mix(in srgb, ' + color + ' 28%, transparent)';
              mark.style.boxShadow = 'inset 0 -1px ' + color;
            }
            fragment.append(mark);
          }
        }
        overlay.replaceChildren(fragment);
        const pageWrapper = overlay.parentElement;
        if (pageWrapper) pageWrapper.style.opacity = '1';
      }
    });
  }

  zoomIn(): void {
    this.zoom.update((value) => Math.min(2.5, value + 0.25));
  }
  zoomOut(): void {
    this.zoom.update((value) => Math.max(0.5, value - 0.25));
  }
  resetZoom(): void {
    this.zoom.set(1);
  }
  zoomPercent(): string {
    return (this.zoom() * 100).toFixed(0) + '%';
  }
  fitWidth(): void {
    this.zoom.set(1);
  }
  fitHeight(): void {
    this.zoom.set(0.5);
  }
}
