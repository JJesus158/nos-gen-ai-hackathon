import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import {
  AnalyzedDocument,
  DOCUMENT_PROCESSOR,
  DocumentEntity,
  ProcessedDocument,
} from './document-processor';
import {
  CATEGORY_DETAILS,
  MAX_CATEGORY_LABEL_LENGTH,
  customCategoryCode,
  normalizeCategoryLabel,
} from './document-categories';
import { TRANSLATIONS } from './language.service';
import { TextRange, maskReplacement, overlaps, splitsSurrogatePair } from './manual-selection';

export type DocumentStage = 'document' | 'analysis' | 'anonymization' | 'results';

/** A summary belongs to the result it was made from; another result starts over. */
interface SummaryState {
  readonly result: ProcessedDocument;
  readonly text: string | null;
  readonly pending: boolean;
  readonly failed: boolean;
}
export type SelectionState = 'all' | 'some' | 'none';

export const MIN_ANONYMIZATION_DURATION = 5000;

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
  private readonly categories = signal<readonly string[]>([]);
  private readonly summaryState = signal<SummaryState | null>(null);
  private request = 0;
  private controller?: AbortController;
  private manualCount = 0;

  readonly file = this.selected.asReadonly();
  readonly analysis = this.analyzed.asReadonly();
  readonly result = this.processed.asReadonly();
  readonly selectedEntityIds = this.selection.asReadonly();
  readonly selectedCount = computed(() => this.selectedEntityIds().length);
  readonly stage = this.currentStage.asReadonly();
  readonly processing = this.pending.asReadonly();
  readonly error = this.failed.asReadonly();
  /** Names of the categories created by the user in this session; never persisted. */
  readonly customCategories = this.categories.asReadonly();
  /** The current result rewritten as readable text, once summarize() succeeded. */
  readonly summary = computed(() => this.summaryOf(this.processed())?.text ?? null);
  readonly summarizing = computed(() => this.summaryOf(this.processed())?.pending ?? false);
  readonly summaryError = computed(() => this.summaryOf(this.processed())?.failed ?? false);
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

  /**
   * Adds occurrences the user marked by hand to the analysis, selected, and returns their IDs in
   * the order of `ranges`. All or nothing: returns [] and changes nothing when any range is out of
   * bounds, empty, splits a surrogate pair or overlaps identified data or another range.
   */
  addManualEntities(ranges: readonly TextRange[], type: string): readonly string[] {
    const analysis = this.analysis();
    if (!analysis || this.processing() || !type.trim() || !ranges.length) return [];
    const text = analysis.originalText;
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    const valid = sorted.every(
      (range, index) =>
        Number.isInteger(range.start) &&
        Number.isInteger(range.end) &&
        range.start >= 0 &&
        range.end > range.start &&
        range.end <= text.length &&
        !splitsSurrogatePair(text, range.start) &&
        !splitsSurrogatePair(text, range.end) &&
        (index === 0 || sorted[index - 1].end <= range.start) &&
        !overlaps(range, analysis.entities),
    );
    if (!valid) return [];
    const ids = new Set(analysis.entities.map((entity) => entity.id));
    const created = ranges.map(({ start, end }): DocumentEntity => {
      let id = `manual-${++this.manualCount}`;
      while (ids.has(id)) id = `manual-${++this.manualCount}`;
      const replacement = maskReplacement(text.slice(start, end));
      return { id, start, end, type, replacement, manual: true };
    });
    const entities = [...analysis.entities, ...created].sort((a, b) => a.start - b.start);
    const selection = new Set([...this.selectedEntityIds(), ...created.map((entity) => entity.id)]);
    this.analyzed.set({ ...analysis, entities });
    this.selection.set(
      entities.filter((entity) => selection.has(entity.id)).map((entity) => entity.id),
    );
    this.processed.set(null);
    this.currentStage.set('analysis');
    this.failed.set(false);
    return created.map((entity) => entity.id);
  }

  /** Removes an occurrence marked by hand; detected occurrences can only be deselected. */
  removeManualEntity(id: string): void {
    const analysis = this.analysis();
    const entity = analysis?.entities.find((item) => item.id === id);
    if (!analysis || !entity?.manual || this.processing()) return;
    this.analyzed.set({
      ...analysis,
      entities: analysis.entities.filter((entity) => entity.id !== id),
    });
    this.selection.set(this.selectedEntityIds().filter((selected) => selected !== id));
    this.processed.set(null);
    this.currentStage.set('analysis');
    this.failed.set(false);
  }

  /**
   * Code of a category named by the user, for this session only. A name already created is reused
   * whatever its case, and the label of a built-in category in either language gives that category
   * instead. Returns '' for a blank or too long name.
   */
  addCustomCategory(label: string): string {
    const name = normalizeCategoryLabel(label);
    if (!name || name.length > MAX_CATEGORY_LABEL_LENGTH) return '';
    const key = name.toLowerCase();
    const builtIn = Object.entries(CATEGORY_DETAILS).find(([, details]) =>
      TRANSLATIONS.some((text) => text[details.labelKey].toLowerCase() === key),
    );
    if (builtIn) return builtIn[0];
    const existing = this.categories().find((category) => category.toLowerCase() === key);
    if (!existing) this.categories.update((categories) => [...categories, name]);
    return customCategoryCode(existing ?? name);
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
      this.manualCount = 0;
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

  /**
   * Asks for a readable rewrite of the current result, for the same selection, in `language`.
   * Leaving the results (back, another document) abandons it; a new result starts over.
   */
  async summarize(language: string): Promise<boolean> {
    const analysis = this.analysis();
    const result = this.result();
    if (!analysis || !result || this.processing() || this.summarizing()) return false;
    const selectedIds = result.entities.map((entity) => entity.id);
    const request = ++this.request;
    const controller = new AbortController();
    this.controller = controller;
    this.summaryState.set({ result, text: null, pending: true, failed: false });
    try {
      const text = await this.processor.summarize(
        analysis,
        selectedIds,
        language,
        controller.signal,
      );
      if (request !== this.request || controller.signal.aborted) return false;
      if (typeof text !== 'string' || !text.trim()) throw new Error('Invalid summary');
      this.summaryState.set({ result, text, pending: false, failed: false });
      return true;
    } catch {
      if (request === this.request && !controller.signal.aborted) {
        this.summaryState.set({ result, text: null, pending: false, failed: true });
      }
      return false;
    } finally {
      if (request === this.request) this.controller = undefined;
    }
  }

  private summaryOf(result: ProcessedDocument | null): SummaryState | null {
    const state = this.summaryState();
    return state && result && state.result === result ? state : null;
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
