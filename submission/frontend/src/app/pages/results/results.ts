import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  output,
  signal,
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
  /** A .txt download (the backend's fallback, or the local example) is shown as text. */
  protected readonly resultIsPdf = computed(
    () => this.documents.result()?.download.blob.type === 'application/pdf',
  );
  /** What the "Anonymized" panel shows once a summary exists. */
  protected readonly view = signal<'masked' | 'summary'>('masked');

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

  protected async summarize(): Promise<void> {
    if (await this.documents.summarize(this.language.preference())) this.view.set('summary');
  }

  protected download(): void {
    const result = this.documents.result();
    if (result) saveFile(result.download.blob, result.download.name);
  }

  protected downloadSummary(): void {
    const summary = this.documents.summary();
    if (summary === null) return;
    const stem = this.documents.file()?.name.replace(/\.[^.]+$/, '') || 'document';
    saveFile(new Blob([summary], { type: 'text/plain;charset=utf-8' }), `${stem}-summary.txt`);
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
