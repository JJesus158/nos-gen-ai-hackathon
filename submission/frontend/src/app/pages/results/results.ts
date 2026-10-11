import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  Injector,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DocumentService } from '../../document.service';
import { LanguageService } from '../../language.service';
import { DocumentProgress } from '../../document-progress';
import { faArrowLeft, faDownload, faWandMagicSparkles } from '@fortawesome/free-solid-svg-icons';
import { categoryDetails } from '../../document-categories';
import { PdfPreview } from '../../pdf-preview';
import { createBoxedPdf } from '../../pdf-highlight';

@Component({
  selector: 'app-results',
  imports: [DocumentProgress, PdfPreview],
  templateUrl: './results.html',
  styleUrl: './results.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Results {
  readonly restart = output<void>();
  readonly back = output<void>();
  protected readonly language = inject(LanguageService);
  protected readonly documents = inject(DocumentService);
  protected readonly downloadIcon = faDownload;
  protected readonly backIcon = faArrowLeft;
  protected readonly summarizeIcon = faWandMagicSparkles;
  protected readonly categoryDetails = categoryDetails;
  /**
   * "asterisk" is the protected PDF as the backend returned it; "boxes" is the
   * same file with grey rounded boxes over the removed values. Both are built
   * from the protected PDF, so what is shown is what is downloaded.
   */
  protected readonly maskMode = signal<'boxes' | 'asterisk'>('asterisk');
  protected readonly boxedPdf = signal<Blob | null>(null);
  protected readonly originalPreviewFailed = signal(false);
  protected readonly resultPreviewFailed = signal(false);
  /** A .txt download (the backend's fallback, or the local example) is shown as text. */
  protected readonly resultIsPdf = computed(
    () => this.documents.result()?.download.blob.type === 'application/pdf',
  );
  /** What the "Anonymized" panel shows once a summary exists. */
  protected readonly view = signal<'masked' | 'summary'>('masked');
  /** For the status region: "Summary ready" once it arrives. */
  protected readonly announcement = signal('');
  /** The main button saves what the panel shows: the summary or the document. */
  protected readonly savesSummary = computed(
    () => this.view() === 'summary' && this.documents.summary() !== null,
  );
  protected readonly summaryName = computed(
    () => `${this.documents.file()?.name.replace(/\.[^.]+$/, '') || 'document'}-summary.txt`,
  );
  /** A summary exists, but the interface language changed since: offer it again. */
  protected readonly summaryOutdated = computed(
    () =>
      this.documents.summary() !== null &&
      this.documents.summaryLanguage() !== this.language.preference(),
  );
  private readonly injector = inject(Injector);
  private readonly summaryOption = viewChild<ElementRef<HTMLButtonElement>>('summaryOption');
  /* Keeps the original and protected panels scrolled together (not in the summary view). */
  private readonly originalScroll = viewChild<ElementRef<HTMLDivElement>>('originalScroll');
  private readonly protectedScroll = viewChild<ElementRef<HTMLDivElement>>('protectedScroll');
  private syncingScroll = false;

  constructor() {
    effect((onCleanup) => {
      const result = this.documents.result();
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });
      this.originalPreviewFailed.set(false);
      this.resultPreviewFailed.set(false);
      this.boxedPdf.set(null);
      // Only the protected PDF is decorated, never the original document.
      if (!result || result.download.blob.type !== 'application/pdf') return;
      void createBoxedPdf(result.download.blob, result.entities, result.originalText)
        .then((pdf) => {
          if (!cancelled) this.boxedPdf.set(pdf);
        })
        .catch(() => {
          if (!cancelled) this.boxedPdf.set(null);
        });
    });
  }

  protected async summarize(): Promise<void> {
    this.announcement.set('');
    if (!(await this.documents.summarize(this.language.preference()))) return;
    this.view.set('summary');
    this.announcement.set(this.language.text().summaryReady);
    // The button that opened it is gone: keep the keyboard on the summary's switch.
    afterNextRender(() => this.summaryOption()?.nativeElement.focus({ preventScroll: true }), {
      injector: this.injector,
    });
  }

  /** The protected document, with the grey boxes when that mode is shown. */
  protected download(): void {
    const result = this.documents.result();
    if (!result) return;
    const boxed = this.maskMode() === 'boxes' ? this.boxedPdf() : null;
    saveFile(boxed ?? result.download.blob, result.download.name);
  }

  protected syncScroll(source: 'original' | 'protected'): void {
    if (this.syncingScroll || this.view() === 'summary') return;
    const from =
      source === 'original'
        ? this.originalScroll()?.nativeElement
        : this.protectedScroll()?.nativeElement;
    const to =
      source === 'original'
        ? this.protectedScroll()?.nativeElement
        : this.originalScroll()?.nativeElement;
    if (!from || !to) return;

    this.syncingScroll = true;
    to.scrollTop = from.scrollTop;
    to.scrollLeft = from.scrollLeft;
    requestAnimationFrame(() => {
      this.syncingScroll = false;
    });
  }

  protected downloadSummary(): void {
    const summary = this.documents.summary();
    if (summary === null) return;
    saveFile(new Blob([summary], { type: 'text/plain;charset=utf-8' }), this.summaryName());
  }

  protected backToReview(): void {
    this.back.emit();
  }
}

function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
