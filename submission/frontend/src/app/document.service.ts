import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import {
  AnalyzedDocument,
  DOCUMENT_PROCESSOR,
  DocumentEntity,
  ProcessedDocument,
} from './document-processor';

export type DocumentStage = 'document' | 'analysis' | 'anonymization' | 'results';
export type SelectionState = 'all' | 'some' | 'none';

export const MIN_ANONYMIZATION_DURATION = 500;

@Injectable({ providedIn: 'root' })
export class DocumentService {
  private readonly processor = inject(DOCUMENT_PROCESSOR);
  private readonly selected = signal<File | null>(null);
  private readonly analyzed = signal<AnalyzedDocument | null>(null);
  private readonly processed = signal<ProcessedDocument | null>(null);
  private readonly selection = signal<readonly string[]>([]);
  private readonly currentStage = signal<DocumentStage>('document');
  private readonly pending = signal(false);
  private readonly failed = signal(false);
  private request = 0;
  private controller?: AbortController;

  readonly file = this.selected.asReadonly();
  readonly analysis = this.analyzed.asReadonly();
  readonly result = this.processed.asReadonly();
  readonly selectedEntityIds = this.selection.asReadonly();
  readonly selectedCount = computed(() => this.selectedEntityIds().length);
  readonly stage = this.currentStage.asReadonly();
  readonly processing = this.pending.asReadonly();
  readonly error = this.failed.asReadonly();
  readonly originalSegments = computed(() => {
    const analysis = this.analysis();
    if (!analysis) return [];
    const segments: { text: string; sensitive: boolean; entityId?: string; type?: string }[] = [];
    let cursor = 0;
    for (const entity of [...analysis.entities].sort((a, b) => a.start - b.start)) {
      if (entity.start > cursor) {
        segments.push({
          text: analysis.originalText.slice(cursor, entity.start),
          sensitive: false,
        });
      }
      segments.push({
        text: analysis.originalText.slice(entity.start, entity.end),
        sensitive: true,
        entityId: entity.id,
        type: entity.type,
      });
      cursor = entity.end;
    }
    if (cursor < analysis.originalText.length) {
      segments.push({ text: analysis.originalText.slice(cursor), sensitive: false });
    }
    return segments;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clear());
  }

  select(file: File): void {
    this.clear();
    this.selected.set(file);
  }

  returnToDocument(): void {
    if (this.processing()) return;
    this.request++;
    this.controller?.abort();
    this.controller = undefined;
    this.analyzed.set(null);
    this.processed.set(null);
    this.selection.set([]);
    this.currentStage.set('document');
    this.failed.set(false);
  }

  returnToReview(): void {
    if (this.processing() || !this.analysis()) return;
    this.request++;
    this.controller?.abort();
    this.controller = undefined;
    this.processed.set(null);
    this.currentStage.set('analysis');
    this.failed.set(false);
  }

  isSelected(id: string): boolean {
    return this.selectedEntityIds().includes(id);
  }

  selectionState(ids: readonly string[]): SelectionState {
    const count = ids.filter((id) => this.isSelected(id)).length;
    return count === 0 ? 'none' : count === ids.length ? 'all' : 'some';
  }

  setEntities(ids: readonly string[], checked: boolean): void {
    const analysis = this.analysis();
    if (!analysis || this.processing()) return;
    const selection = new Set(this.selectedEntityIds());
    for (const id of ids) {
      if (checked) selection.add(id);
      else selection.delete(id);
    }
    const next = analysis.entities
      .filter((entity) => selection.has(entity.id))
      .map((entity) => entity.id);
    const previous = this.selectedEntityIds();
    if (next.length === previous.length && next.every((id, index) => id === previous[index]))
      return;
    this.selection.set(next);
    this.processed.set(null);
    this.currentStage.set('analysis');
    this.failed.set(false);
  }

  selectAll(checked: boolean): void {
    this.setEntities(this.analysis()?.entities.map((entity) => entity.id) ?? [], checked);
  }

  async analyze(): Promise<boolean> {
    const file = this.file();
    if (!file || this.processing()) return false;
    const request = ++this.request;
    const controller = new AbortController();
    this.controller = controller;
    this.pending.set(true);
    this.failed.set(false);
    this.analyzed.set(null);
    this.processed.set(null);
    this.selection.set([]);
    this.currentStage.set('analysis');
    try {
      const analysis = await this.processor.analyze(file, controller.signal);
      if (request !== this.request || controller.signal.aborted) return false;
      validateAnalysis(analysis);
      this.analyzed.set(analysis);
      this.selection.set(analysis.entities.map((entity) => entity.id));
      return true;
    } catch {
      if (request === this.request && !controller.signal.aborted) this.failed.set(true);
      return false;
    } finally {
      if (request === this.request) {
        this.pending.set(false);
        this.controller = undefined;
      }
    }
  }

  async anonymize(minimumDuration = 0): Promise<boolean> {
    const analysis = this.analysis();
    if (!analysis || this.processing()) return false;
    const selectedIds = [...this.selectedEntityIds()];
    const request = ++this.request;
    const controller = new AbortController();
    this.controller = controller;
    this.pending.set(true);
    this.failed.set(false);
    this.processed.set(null);
    this.currentStage.set('anonymization');
    const startedAt = performance.now();
    try {
      const result = await this.processor.anonymize(analysis, selectedIds, controller.signal);
      if (request !== this.request || controller.signal.aborted) return false;
      validateResult(result, analysis, selectedIds);
      if (!(await waitForMinimumDuration(startedAt, minimumDuration, controller.signal)))
        return false;
      this.processed.set(result);
      this.currentStage.set('results');
      return true;
    } catch {
      if (request === this.request && !controller.signal.aborted) {
        this.failed.set(true);
        this.currentStage.set('analysis');
      }
      return false;
    } finally {
      if (request === this.request) {
        this.pending.set(false);
        this.controller = undefined;
      }
    }
  }

  clear(): void {
    this.request++;
    this.controller?.abort();
    this.controller = undefined;
    this.selected.set(null);
    this.analyzed.set(null);
    this.processed.set(null);
    this.selection.set([]);
    this.currentStage.set('document');
    this.pending.set(false);
    this.failed.set(false);
  }
}

function waitForMinimumDuration(
  startedAt: number,
  minimumDuration: number,
  signal: AbortSignal,
): Promise<boolean> {
  const remaining = minimumDuration - (performance.now() - startedAt);
  if (remaining <= 0) return Promise.resolve(!signal.aborted);
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (completed: boolean) => {
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve(completed && !signal.aborted);
    };
    const onAbort = () => finish(false);
    timeout = setTimeout(() => finish(true), remaining);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function validateAnalysis(value: AnalyzedDocument): void {
  if (
    !value ||
    typeof value.id !== 'string' ||
    !value.id.trim() ||
    typeof value.originalText !== 'string' ||
    (value.source !== 'example' && value.source !== 'api')
  ) {
    throw new Error('Invalid document analysis');
  }
  validateEntities(value.originalText, value.entities);
}

function validateResult(
  value: ProcessedDocument,
  analysis: AnalyzedDocument,
  selectedIds: readonly string[],
): void {
  if (
    !value ||
    value.originalText !== analysis.originalText ||
    typeof value.anonymizedText !== 'string' ||
    !value.download ||
    typeof value.download.name !== 'string' ||
    !value.download.name.trim() ||
    !(value.download.blob instanceof Blob) ||
    value.source !== analysis.source
  ) {
    throw new Error('Invalid document result');
  }
  validateEntities(value.originalText, value.entities);
  if (
    value.entities.length !== selectedIds.length ||
    value.entities.some((entity) => !selectedIds.includes(entity.id))
  ) {
    throw new Error('Result does not match the selected occurrences');
  }
}

function validateEntities(text: string, entities: readonly DocumentEntity[]): void {
  if (!Array.isArray(entities)) throw new Error('Invalid document entities');
  const ids = new Set<string>();
  let previousEnd = 0;
  for (const entity of [...entities].sort((a, b) => a?.start - b?.start)) {
    if (
      !entity ||
      typeof entity.id !== 'string' ||
      !entity.id.trim() ||
      ids.has(entity.id) ||
      !Number.isInteger(entity.start) ||
      !Number.isInteger(entity.end) ||
      entity.start < previousEnd ||
      entity.end <= entity.start ||
      entity.end > text.length ||
      typeof entity.type !== 'string' ||
      !entity.type.trim() ||
      typeof entity.replacement !== 'string' ||
      (entity.reason !== undefined && typeof entity.reason !== 'string')
    ) {
      throw new Error('Invalid document entity');
    }
    ids.add(entity.id);
    previousEnd = entity.end;
  }
}
