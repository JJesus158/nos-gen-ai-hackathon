import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { DocumentService } from '../../document.service';
import { LanguageService } from '../../language.service';
import { DocumentProgress } from '../../document-progress';
import { faArrowLeft, faDownload } from '@fortawesome/free-solid-svg-icons';
import { categoryDetails } from '../../document-categories';

@Component({
  selector: 'app-results',
  imports: [DocumentProgress],
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
  protected readonly categoryDetails = categoryDetails;
  protected readonly maskMode = signal<'blur' | 'asterisk'>('blur');
  protected readonly displaySegments = computed(() => {
    const result = this.documents.result();
    if (!result) return [];
    const selected = new Map(result.entities.map((entity) => [entity.id, entity]));
    const segments: { text: string; masked: boolean }[] = [];
    let cursor = 0;
    for (const entity of [...result.entities].sort((a, b) => a.start - b.start)) {
      if (entity.start > cursor) {
        segments.push({ text: result.originalText.slice(cursor, entity.start), masked: false });
      }
      const text = result.originalText.slice(entity.start, entity.end);
      segments.push({
        text: this.maskMode() === 'asterisk' ? maskWithAsterisks(text) : text,
        masked: selected.has(entity.id),
      });
      cursor = entity.end;
    }
    if (cursor < result.originalText.length) {
      segments.push({ text: result.originalText.slice(cursor), masked: false });
    }
    return segments;
  });

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

  protected backToReview(): void {
    this.back.emit();
  }
}

function maskWithAsterisks(value: string): string {
  return value.replace(/\S+/g, '*');
}
