import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  Injector,
  inject,
  signal,
} from '@angular/core';
import {
  faArrowLeft,
  faArrowRight,
  faArrowsLeftRight,
  faFileArrowUp,
  faShieldHalved,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { DocumentService, MIN_ANONYMIZATION_DURATION } from '../../document.service';
import { LanguageService } from '../../language.service';
import { DocumentProgress } from '../../document-progress';
import { Results } from '../results/results';
import { PdfPreview } from '../../pdf-preview';
import { EntitySelection } from '../../entity-selection';
import { categoryDetails } from '../../document-categories';
import { createHighlightedPdf } from '../../pdf-highlight';
import { entityPdfBoxes } from '../../pdf-mapping';

@Component({
  selector: 'app-anonymize',
  imports: [DocumentProgress, Results, PdfPreview, EntitySelection],
  templateUrl: './anonymize.html',
  styleUrl: './anonymize.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Anonymize {
  protected readonly language = inject(LanguageService);
  protected readonly documents = inject(DocumentService);
  protected readonly fileFormat = computed(
    () => this.documents.file()?.name.split('.').pop()?.toUpperCase() ?? '',
  );
  protected readonly removeIcon = faXmark;
  protected readonly uploadIcon = faFileArrowUp;
  protected readonly nextIcon = faArrowRight;
  protected readonly anonymizationIcon = faShieldHalved;
  protected readonly backIcon = faArrowLeft;
  protected readonly fitWidthIcon = faArrowsLeftRight;
  protected readonly categoryDetails = categoryDetails;
  protected readonly dragging = signal(false);
  protected readonly previewZoom = signal(1);
  protected readonly previewFit = signal<'width' | 'height'>('width');
  protected readonly pdfMappingAvailable = computed(() => {
    const analysis = this.documents.analysis();
    return (
      analysis?.source === 'api' &&
      analysis.entities.every((entity) => entityPdfBoxes(entity, analysis.originalText).length > 0)
    );
  });
  protected readonly highlightedPdf = signal<Blob | null>(null);
  protected readonly pdfPreviewFailed = signal(false);
  protected readonly error = signal<'fileError' | 'emptyPdf' | null>(null);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  constructor() {
    effect((onCleanup) => {
      const file = this.documents.file();
      const analysis = this.documents.analysis();
      const selectedIds = this.documents.selectedEntityIds();
      const mappingAvailable = this.pdfMappingAvailable();
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });
      this.pdfPreviewFailed.set(false);
      if (!file || !analysis || !mappingAvailable) {
        this.highlightedPdf.set(null);
        return;
      }
      void createHighlightedPdf(file, analysis.entities, selectedIds, analysis.originalText)
        .then((pdf) => {
          if (!cancelled) this.highlightedPdf.set(pdf);
        })
        .catch(() => {
          if (!cancelled) this.pdfPreviewFailed.set(true);
        });
    });
  }

  protected choose(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) this.select(Array.from(input.files));
    input.value = '';
  }

  protected dragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(!this.documents.processing());
  }
  protected drop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    this.select(Array.from(event.dataTransfer?.files ?? []));
  }
  protected remove(): void {
    this.documents.clear();
    this.error.set(null);
    this.focusHeading();
  }

  protected async startAnalysis(): Promise<void> {
    if (await this.documents.analyze()) this.focusHeading();
  }

  protected async anonymizeSelected(): Promise<void> {
    if (await this.documents.anonymize(MIN_ANONYMIZATION_DURATION)) this.focusHeading();
  }

  protected backToDocument(): void {
    this.documents.returnToDocument();
    this.focusHeading();
  }

  protected backToReview(): void {
    this.documents.returnToReview();
    this.focusHeading();
  }

  protected zoomPreviewIn(): void {
    this.previewFit.set('width');
    this.previewZoom.update((value) => Math.min(2.5, value + 0.25));
  }

  protected zoomPreviewOut(): void {
    this.previewFit.set('width');
    this.previewZoom.update((value) => Math.max(0.5, value - 0.25));
  }

  protected resetPreviewZoom(): void {
    this.previewFit.set('width');
    this.previewZoom.set(1);
  }

  protected fitPreviewWidth(): void {
    this.previewFit.set('width');
    this.previewZoom.set(1);
  }

  protected fitPreviewHeight(): void {
    this.previewFit.set('height');
    this.previewZoom.set(1);
  }

  private focusHeading(): void {
    afterNextRender(
      () =>
        this.host.nativeElement.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true }),
      { injector: this.injector },
    );
  }

  private select(files: File[]): void {
    if (this.documents.processing()) return;
    const file = files[0];
    if (
      files.length !== 1 ||
      !file ||
      !/\.pdf$/i.test(file.name) ||
      (file.type !== '' && file.type !== 'application/pdf')
    ) {
      this.error.set('fileError');
      return;
    }
    if (!file.size) {
      this.error.set('emptyPdf');
      return;
    }
    this.error.set(null);
    this.documents.select(file);
  }
}
