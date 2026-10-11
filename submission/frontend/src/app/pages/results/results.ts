import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
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
import { createBlurredPreviewPdf } from '../../pdf-highlight';

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
  /** "asterisk" shows the file that is downloaded; "blur" previews the original with its data covered. */
  protected readonly maskMode = signal<'blur' | 'asterisk'>('asterisk');
  protected readonly blurredPreviewPdf = signal<Blob | null>(null);
  protected readonly originalPreviewFailed = signal(false);
  protected readonly resultPreviewFailed = signal(false);
  protected readonly view = signal<'masked' | 'summary'>('masked');
  private readonly originalScroll = viewChild<ElementRef<HTMLDivElement>>('originalScroll');
  private readonly protectedScroll = viewChild<ElementRef<HTMLDivElement>>('protectedScroll');
  private syncingScroll = false;
  /** A .txt download (the backend's fallback, or the local example) is shown as text. */
  protected readonly resultIsPdf = computed(
    () => this.documents.result()?.download.blob.type === 'application/pdf',
  );

  constructor() {
    effect((onCleanup) => {
      const result = this.documents.result();
      const source = this.documents.file();
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });
      this.originalPreviewFailed.set(false);
      this.resultPreviewFailed.set(false);
      if (!result || !source) {
        this.blurredPreviewPdf.set(null);
        return;
      }
      void createBlurredPreviewPdf(source, result.entities, result.originalText)
        .then((pdf) => {
          if (!cancelled) this.blurredPreviewPdf.set(pdf);
        })
        .catch(() => {
          if (!cancelled) this.blurredPreviewPdf.set(null);
        });
    });
  }
  protected download(): void {
    const result = this.documents.result();
    if (!result) return;
    const url = URL.createObjectURL(result.download.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = result.download.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  protected async summarize(): Promise<void> {
    await this.documents.summarize(this.language.preference());
    if (this.documents.summary()) this.view.set('summary');
  }

  protected downloadSummary(): void {
    const summary = this.documents.summary();
    if (!summary) return;
    const blob = new Blob([summary], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'dataveil-summary.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  }

  protected backToReview(): void {
    this.back.emit();
  }

  protected syncScroll(source: 'original' | 'protected'): void {
    if (this.syncingScroll || this.view() === 'summary') return;
    const from = source === 'original' ? this.originalScroll()?.nativeElement : this.protectedScroll()?.nativeElement;
    const to = source === 'original' ? this.protectedScroll()?.nativeElement : this.originalScroll()?.nativeElement;
    if (!from || !to) return;

    this.syncingScroll = true;
    to.scrollTop = from.scrollTop;
    to.scrollLeft = from.scrollLeft;
    requestAnimationFrame(() => {
      this.syncingScroll = false;
    });
  }
}
