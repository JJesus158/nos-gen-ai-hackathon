import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { faCheck } from '@fortawesome/free-solid-svg-icons';
import { DocumentService } from './document.service';
import { LanguageService } from './language.service';

@Component({
  selector: 'app-document-progress',
  templateUrl: './document-progress.html',
  styleUrl: './document-progress.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DocumentProgress {
  protected readonly language = inject(LanguageService);
  private readonly documents = inject(DocumentService);
  protected readonly completeIcon = faCheck;
  protected readonly steps = [
    'documentStep',
    'analysisStep',
    'anonymizationStep',
    'resultsStep',
  ] as const;
  protected readonly current = computed(() => {
    if (!this.documents.file() && this.documents.stage() === 'document') return 0;
    return ['document', 'analysis', 'anonymization', 'results'].indexOf(this.documents.stage()) + 1;
  });
}
