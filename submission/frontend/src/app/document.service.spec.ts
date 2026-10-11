import { TestBed } from '@angular/core/testing';
import {
  AnalyzedDocument,
  DOCUMENT_PROCESSOR,
  DocumentProcessor,
  ProcessedDocument,
} from './document-processor';
import { DocumentService } from './document.service';
import { exampleDocumentProcessor } from './example-document';
import { LanguageService } from './language.service';
import { MANUAL_STORAGE_KEY } from './manual-storage';

/** Every test starts without stored marks and leaves the browser storage as it found it. */
function isolateStoredMarks(): void {
  let saved: string | null;
  beforeEach(() => {
    saved = localStorage.getItem(MANUAL_STORAGE_KEY);
    localStorage.removeItem(MANUAL_STORAGE_KEY);
  });
  afterEach(() => {
    if (saved === null) localStorage.removeItem(MANUAL_STORAGE_KEY);
    else localStorage.setItem(MANUAL_STORAGE_KEY, saved);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function analysis(): AnalyzedDocument {
  return {
    id: 'analysis-1',
    originalText: 'Ana e Ana, NIF 123.',
    entities: [
      { id: 'name-1', start: 0, end: 3, type: 'NAME', replacement: '[NOME]' },
      { id: 'name-2', start: 6, end: 9, type: 'NAME', replacement: '[NOME]' },
      { id: 'id-1', start: 15, end: 18, type: 'ID', replacement: '[ID]' },
    ],
    source: 'api',
  };
}

function result(
  document = analysis(),
  ids: readonly string[] = document.entities.map((entity) => entity.id),
): ProcessedDocument {
  const entities = document.entities.filter((entity) => ids.includes(entity.id));
  let anonymizedText = document.originalText;
  for (const entity of [...entities].sort((a, b) => b.start - a.start)) {
    anonymizedText =
      anonymizedText.slice(0, entity.start) + entity.replacement + anonymizedText.slice(entity.end);
  }
  return {
    originalText: document.originalText,
    anonymizedText,
    entities,
    download: {
      name: 'protected.pdf',
      blob: new Blob(['%PDF-backend-selected-result'], { type: 'application/pdf' }),
    },
    source: document.source,
  };
}

describe('Document selection workflow', () => {
  let processor: jasmine.SpyObj<DocumentProcessor>;
  let documents: DocumentService;
  let file: File;

  isolateStoredMarks();

  beforeEach(() => {
    processor = jasmine.createSpyObj<DocumentProcessor>('processor', [
      'analyze',
      'anonymize',
      'summarize',
    ]);
    processor.analyze.and.resolveTo(analysis());
    processor.anonymize.and.callFake(async (document, ids) => result(document, ids));
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT_PROCESSOR, useValue: processor }],
    });
    documents = TestBed.inject(DocumentService);
    file = new File(['%PDF-input'], 'account.pdf', { type: 'application/pdf' });
  });

  async function analyzeSelected(): Promise<void> {
    documents.select(file);
    expect(await documents.analyze()).toBeTrue();
  }

  it('advances from document only when analysis starts and guards missing inputs', async () => {
    expect(await documents.analyze()).toBeFalse();
    expect(await documents.anonymize()).toBeFalse();
    documents.select(file);
    expect(documents.stage()).toBe('document');
    expect(documents.analysis()).toBeNull();
    expect(await documents.anonymize()).toBeFalse();
    expect(processor.analyze).not.toHaveBeenCalled();
    expect(processor.anonymize).not.toHaveBeenCalled();
  });

  it('tracks pending analysis, prevents duplicates and selects every returned occurrence', async () => {
    const pending = deferred<AnalyzedDocument>();
    processor.analyze.and.returnValue(pending.promise);
    documents.select(file);
    const request = documents.analyze();
    expect(documents.processing()).toBeTrue();
    expect(documents.stage()).toBe('analysis');
    expect(await documents.analyze()).toBeFalse();
    expect(await documents.anonymize()).toBeFalse();
    expect(processor.analyze).toHaveBeenCalledTimes(1);
    expect(processor.analyze.calls.mostRecent().args[0]).toBe(file);
    expect(processor.analyze.calls.mostRecent().args[1] instanceof AbortSignal).toBeTrue();
    pending.resolve(analysis());
    expect(await request).toBeTrue();
    expect(documents.processing()).toBeFalse();
    expect(documents.stage()).toBe('analysis');
    expect(documents.result()).toBeNull();
    expect(documents.selectedEntityIds()).toEqual(['name-1', 'name-2', 'id-1']);
    expect(documents.selectedCount()).toBe(3);
  });

  it('supports all, category and individual selection with independent repeated values', async () => {
    await analyzeSelected();
    const names = ['name-1', 'name-2'];
    expect(documents.selectionState(names)).toBe('all');
    documents.setEntities(names, false);
    expect(documents.selectedEntityIds()).toEqual(['id-1']);
    expect(documents.selectionState(names)).toBe('none');
    documents.setEntities(['name-2', 'unknown'], true);
    expect(documents.selectionState(names)).toBe('some');
    expect(documents.isSelected('name-1')).toBeFalse();
    expect(documents.isSelected('name-2')).toBeTrue();
    expect(documents.selectedCount()).toBe(2);
    documents.selectAll(false);
    expect(documents.selectedCount()).toBe(0);
    documents.selectAll(true);
    expect(documents.selectedCount()).toBe(3);
    expect(documents.selectionState([])).toBe('none');
  });

  it('preserves original text and IDs in highlighted segments for individually selectable occurrences', async () => {
    await analyzeSelected();
    const segments = documents.originalSegments();
    expect(segments.map((segment) => segment.text).join('')).toBe(analysis().originalText);
    expect(segments.filter((segment) => segment.sensitive)).toEqual([
      { text: 'Ana', sensitive: true, entityId: 'name-1', type: 'NAME' },
      { text: 'Ana', sensitive: true, entityId: 'name-2', type: 'NAME' },
      { text: '123', sensitive: true, entityId: 'id-1', type: 'ID' },
    ]);
  });

  it('snapshots selected IDs, blocks duplicate work and keeps the actual returned artifact', async () => {
    await analyzeSelected();
    documents.setEntities(['name-2'], false);
    const pending = deferred<ProcessedDocument>();
    processor.anonymize.and.returnValue(pending.promise);
    const request = documents.anonymize();
    const [document, ids, signal] = processor.anonymize.calls.mostRecent().args;
    expect(document).toBe(documents.analysis()!);
    expect(ids).toEqual(['name-1', 'id-1']);
    expect(signal instanceof AbortSignal).toBeTrue();
    expect(documents.stage()).toBe('anonymization');
    expect(await documents.anonymize()).toBeFalse();
    expect(await documents.analyze()).toBeFalse();
    documents.selectAll(false);
    expect(documents.selectedEntityIds()).toEqual(ids);
    const completed = result(document, ids);
    pending.resolve(completed);
    expect(await request).toBeTrue();
    expect(documents.stage()).toBe('results');
    expect(documents.result()!.download.blob).toBe(completed.download.blob);
    expect(documents.result()!.download.name).toBe('protected.pdf');
    expect(documents.result()!.anonymizedText).toBe('[NOME] e Ana, NIF [ID].');
  });

  it('clears an old artifact when selections change after results', async () => {
    await analyzeSelected();
    await documents.anonymize();
    documents.setEntities(['name-1'], false);
    expect(documents.result()).toBeNull();
    expect(documents.stage()).toBe('analysis');
    expect(documents.isSelected('name-1')).toBeFalse();
  });

  it('allows retry after analysis failure without losing the chosen document', async () => {
    processor.analyze.and.returnValues(
      Promise.reject(new Error('Unavailable')),
      Promise.resolve(analysis()),
    );
    documents.select(file);
    expect(await documents.analyze()).toBeFalse();
    expect(documents.error()).toBeTrue();
    expect(documents.stage()).toBe('analysis');
    expect(documents.file()).toBe(file);
    expect(await documents.analyze()).toBeTrue();
    expect(documents.error()).toBeFalse();
  });

  it('returns to review on anonymization failure and preserves choices for retry', async () => {
    await analyzeSelected();
    documents.setEntities(['name-1'], false);
    processor.anonymize.and.returnValues(
      Promise.reject(new Error('Unavailable')),
      Promise.resolve(result(analysis(), ['name-2', 'id-1'])),
    );
    expect(await documents.anonymize()).toBeFalse();
    expect(documents.error()).toBeTrue();
    expect(documents.stage()).toBe('analysis');
    expect(documents.selectedEntityIds()).toEqual(['name-2', 'id-1']);
    expect(documents.result()).toBeNull();
    expect(await documents.anonymize()).toBeTrue();
    expect(documents.error()).toBeFalse();
  });

  it('aborts analysis and ignores a late successful response after removal', async () => {
    const pending = deferred<AnalyzedDocument>();
    processor.analyze.and.returnValue(pending.promise);
    documents.select(file);
    const request = documents.analyze();
    const signal = processor.analyze.calls.mostRecent().args[1];
    documents.clear();
    expect(signal.aborted).toBeTrue();
    expect(documents.stage()).toBe('document');
    pending.resolve(analysis());
    expect(await request).toBeFalse();
    expect(documents.analysis()).toBeNull();
    expect(documents.selectedCount()).toBe(0);
    expect(documents.error()).toBeFalse();
  });

  it('aborts anonymization and ignores a late artifact after replacement', async () => {
    await analyzeSelected();
    const pending = deferred<ProcessedDocument>();
    processor.anonymize.and.returnValue(pending.promise);
    const request = documents.anonymize();
    const signal = processor.anonymize.calls.mostRecent().args[2];
    documents.select(new File(['new'], 'new.pdf', { type: 'application/pdf' }));
    expect(signal.aborted).toBeTrue();
    pending.resolve(result());
    expect(await request).toBeFalse();
    expect(documents.result()).toBeNull();
    expect(documents.analysis()).toBeNull();
    expect(documents.stage()).toBe('document');
    expect(documents.processing()).toBeFalse();
  });

  it('does not let stale analysis success or failure settle a newer request', async () => {
    for (const rejects of [false, true]) {
      const old = deferred<AnalyzedDocument>();
      const current = deferred<AnalyzedDocument>();
      processor.analyze.and.returnValues(old.promise, current.promise);
      documents.select(file);
      const oldRequest = documents.analyze();
      documents.select(file);
      const currentRequest = documents.analyze();
      if (rejects) old.reject(new Error('Late failure'));
      else old.resolve(analysis());
      expect(await oldRequest).toBeFalse();
      expect(documents.processing()).toBeTrue();
      expect(documents.error()).toBeFalse();
      expect(documents.analysis()).toBeNull();
      current.resolve(analysis());
      expect(await currentRequest).toBeTrue();
    }
  });

  it('does not let stale anonymization failure replace a newer analysis', async () => {
    await analyzeSelected();
    const old = deferred<ProcessedDocument>();
    processor.anonymize.and.returnValue(old.promise);
    const oldRequest = documents.anonymize();
    documents.select(file);
    await documents.analyze();
    old.reject(new Error('Late generation failure'));
    expect(await oldRequest).toBeFalse();
    expect(documents.analysis()).not.toBeNull();
    expect(documents.stage()).toBe('analysis');
    expect(documents.error()).toBeFalse();
  });

  it('rejects invalid and duplicate IDs, invalid ranges and overlapping occurrences', async () => {
    const valid = analysis();
    const first = valid.entities[0];
    for (const invalid of [
      { ...valid, id: '' },
      { ...valid, entities: [{ ...first, id: '' }] },
      { ...valid, entities: [first, { ...valid.entities[1], id: first.id }] },
      { ...valid, entities: [{ ...first, start: -1 }] },
      { ...valid, entities: [{ ...first, end: 100 }] },
      { ...valid, entities: [first, { ...valid.entities[1], start: 2 }] },
    ]) {
      processor.analyze.and.resolveTo(invalid);
      documents.select(file);
      expect(await documents.analyze()).toBeFalse();
      expect(documents.analysis()).toBeNull();
      expect(documents.error()).toBeTrue();
      expect(documents.processing()).toBeFalse();
    }
  });

  it('accepts empty detection lists and unknown categories supplied by the backend', async () => {
    for (const entities of [[], [{ ...analysis().entities[0], type: 'FUTURE_CATEGORY' }]]) {
      processor.analyze.and.resolveTo({ ...analysis(), entities });
      await analyzeSelected();
      expect(documents.analysis()!.entities).toEqual(entities);
    }
  });

  it('adds manual occurrences selected and in document order, and removes only those', async () => {
    await analyzeSelected();
    documents.setEntities(['name-2'], false);
    processor.anonymize.and.rejectWith(new Error('Unavailable'));
    expect(await documents.anonymize()).toBeFalse();
    expect(documents.error()).toBeTrue();
    const ids = documents.addManualEntities(
      [
        { start: 11, end: 14 },
        { start: 4, end: 5 },
      ],
      'custom:Sigla',
    );
    expect(ids).toEqual(['manual-1', 'manual-2']);
    expect(documents.error()).toBeFalse();
    expect(documents.stage()).toBe('analysis');
    const entities = documents.analysis()!.entities;
    expect(entities.map((entity) => entity.id)).toEqual([
      'name-1',
      'manual-2',
      'name-2',
      'manual-1',
      'id-1',
    ]);
    expect(entities[3]).toEqual({
      id: 'manual-1',
      start: 11,
      end: 14,
      type: 'custom:Sigla',
      replacement: '*',
      manual: true,
    });
    expect(documents.selectedEntityIds()).toEqual(['name-1', 'manual-2', 'manual-1', 'id-1']);
    expect(documents.originalSegments().map((segment) => segment.text)).toEqual([
      'Ana',
      ' ',
      'e',
      ' ',
      'Ana',
      ', ',
      'NIF',
      ' ',
      '123',
      '.',
    ]);
    documents.removeManualEntity('name-1');
    expect(documents.analysis()!.entities).toBe(entities);
    documents.removeManualEntity('manual-2');
    expect(documents.analysis()!.entities.map((entity) => entity.id)).toEqual([
      'name-1',
      'name-2',
      'manual-1',
      'id-1',
    ]);
    expect(documents.selectedEntityIds()).toEqual(['name-1', 'manual-1', 'id-1']);
    processor.anonymize.and.callFake(async (document, selected) => result(document, selected));
    expect(await documents.anonymize()).toBeTrue();
    expect(processor.anonymize.calls.mostRecent().args[1]).toEqual(['name-1', 'manual-1', 'id-1']);
    expect(documents.result()!.anonymizedText).toBe('[NOME] e Ana, * [ID].');
    documents.removeManualEntity('manual-1');
    expect(documents.result()).toBeNull();
    expect(documents.stage()).toBe('analysis');
    expect(documents.selectedEntityIds()).toEqual(['name-1', 'id-1']);
  });

  it('rejects a whole batch of manual occurrences when any of them is invalid', async () => {
    expect(documents.addManualEntities([{ start: 11, end: 14 }], 'NAME')).toEqual([]);
    await analyzeSelected();
    const before = documents.analysis();
    const selection = documents.selectedEntityIds();
    const invalid: [{ start: number; end: number }[], string][] = [
      [[{ start: 11, end: 14 }], '  '],
      [[], 'NAME'],
      [
        [
          { start: 11, end: 14 },
          { start: -1, end: 0 },
        ],
        'NAME',
      ],
      [
        [
          { start: 11, end: 14 },
          { start: 18, end: 20 },
        ],
        'NAME',
      ],
      [[{ start: 11, end: 11 }], 'NAME'],
      [[{ start: 13, end: 11 }], 'NAME'],
      [[{ start: 11.5, end: 14 }], 'NAME'],
      [
        [
          { start: 11, end: 14 },
          { start: 2, end: 5 },
        ],
        'NAME',
      ],
      [
        [
          { start: 10, end: 14 },
          { start: 12, end: 13 },
        ],
        'NAME',
      ],
    ];
    for (const [ranges, type] of invalid) {
      expect(documents.addManualEntities(ranges, type)).toEqual([]);
      expect(documents.analysis()).toBe(before);
      expect(documents.selectedEntityIds()).toBe(selection);
    }
    const pending = deferred<ProcessedDocument>();
    processor.anonymize.and.returnValue(pending.promise);
    const request = documents.anonymize();
    expect(documents.addManualEntities([{ start: 11, end: 14 }], 'NAME')).toEqual([]);
    expect(documents.analysis()).toBe(before);
    pending.resolve(result());
    expect(await request).toBeTrue();
  });

  it('rejects manual ranges that split a surrogate pair and never reuses an ID', async () => {
    processor.analyze.and.resolveTo({
      id: 'emoji',
      originalText: 'Olá 😀 Ana',
      entities: [{ id: 'manual-1', start: 0, end: 3, type: 'NAME', replacement: '*' }],
      source: 'api',
    });
    await analyzeSelected();
    expect(documents.addManualEntities([{ start: 4, end: 5 }], 'NAME')).toEqual([]);
    expect(documents.addManualEntities([{ start: 5, end: 10 }], 'NAME')).toEqual([]);
    expect(documents.addManualEntities([{ start: 4, end: 6 }], 'NAME')).toEqual(['manual-2']);
    expect(documents.addManualEntities([{ start: 7, end: 10 }], 'NAME')).toEqual(['manual-3']);
    documents.removeManualEntity('manual-1');
    expect(documents.analysis()!.entities.length).toBe(3);
  });

  it('keeps manual occurrences when returning to review and brings them back for the same document', async () => {
    await analyzeSelected();
    expect(documents.addManualEntities([{ start: 11, end: 14 }], 'ID')).toEqual(['manual-1']);
    expect(await documents.anonymize()).toBeTrue();
    documents.returnToReview();
    expect(documents.analysis()!.entities.map((entity) => entity.id)).toContain('manual-1');
    expect(documents.isSelected('manual-1')).toBeTrue();
    const manual = {
      id: 'manual-1',
      start: 11,
      end: 14,
      type: 'ID',
      replacement: '*',
      manual: true,
    };
    expect(await documents.analyze()).toBeTrue();
    expect(documents.analysis()!.entities.filter((entity) => entity.manual)).toEqual([manual]);
    expect(documents.addManualEntities([{ start: 11, end: 14 }], 'ID')).toEqual([]);
    documents.returnToDocument();
    expect(documents.analysis()).toBeNull();
    expect(await documents.analyze()).toBeTrue();
    expect(documents.analysis()!.entities.filter((entity) => entity.manual)).toEqual([manual]);
    expect(documents.isSelected('manual-1')).toBeTrue();
    documents.clear();
    expect(documents.analysis()).toBeNull();
    expect(documents.selectedCount()).toBe(0);
  });

  it('stores where the marks are, never their text, and restores them after a reload', async () => {
    await analyzeSelected();
    documents.addManualEntities([{ start: 4, end: 5 }], documents.addCustomCategory('Sigla'));
    documents.addManualEntities([{ start: 11, end: 14 }], 'ID');
    documents.setEntities(['manual-1', 'name-2'], false);
    const stored = localStorage.getItem(MANUAL_STORAGE_KEY)!;
    expect(stored).not.toContain('NIF');
    expect(stored).not.toContain('account');
    expect(JSON.parse(stored)).toEqual({
      document: jasmine.any(String),
      entities: [
        { start: 4, end: 5, type: 'custom:Sigla', selected: false },
        { start: 11, end: 14, type: 'ID', selected: true },
      ],
    });
    // A reload: nothing is left in memory, and the same file is chosen again.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT_PROCESSOR, useValue: processor }],
    });
    documents = TestBed.inject(DocumentService);
    file = new File(['%PDF-input'], 'account.pdf', { type: 'application/pdf' });
    expect(documents.customCategories()).toEqual([]);
    await analyzeSelected();
    expect(documents.analysis()!.entities.map((entity) => entity.id)).toEqual([
      'name-1',
      'manual-1',
      'name-2',
      'manual-2',
      'id-1',
    ]);
    // Detected occurrences start selected, as after any analysis.
    expect(documents.selectedEntityIds()).toEqual(['name-1', 'name-2', 'manual-2', 'id-1']);
    expect(documents.analysis()!.entities[1].type).toBe('custom:Sigla');
    expect(documents.customCategories()).toEqual(['Sigla']);
  });

  it('replaces the stored marks only when another document is analysed', async () => {
    await analyzeSelected();
    documents.addManualEntities([{ start: 11, end: 14 }], 'ID');
    const other = new File(['%PDF-other'], 'other.pdf', { type: 'application/pdf' });
    // Choosing another file without analysing it leaves them stored.
    documents.select(other);
    await analyzeSelected();
    expect(documents.analysis()!.entities.some((entity) => entity.manual)).toBeTrue();
    // The processor gives the same text, but this is another file.
    documents.select(other);
    expect(await documents.analyze()).toBeTrue();
    expect(documents.analysis()!.entities.some((entity) => entity.manual)).toBeFalse();
    await analyzeSelected();
    expect(documents.analysis()!.entities.some((entity) => entity.manual)).toBeFalse();
  });

  it('leaves out stored marks that no longer fit and ignores invalid storage', async () => {
    await analyzeSelected();
    documents.addManualEntities(
      [
        { start: 4, end: 5 },
        { start: 11, end: 14 },
      ],
      'NAME',
    );
    // The new analysis detects "NIF": the mark over it is dropped, from storage too.
    processor.analyze.and.resolveTo({
      ...analysis(),
      entities: [
        ...analysis().entities,
        { id: 'nif-1', start: 11, end: 14, type: 'ID', replacement: '*' },
      ],
    });
    expect(await documents.analyze()).toBeTrue();
    expect(documents.analysis()!.entities.filter((entity) => entity.manual).length).toBe(1);
    const { document, entities } = JSON.parse(localStorage.getItem(MANUAL_STORAGE_KEY)!);
    expect(entities).toEqual([{ start: 4, end: 5, type: 'NAME', selected: true }]);
    const mark = { start: 4, end: 5, type: 'NAME', selected: true };
    for (const invalid of [
      [{ ...mark, start: 4.5 }],
      [{ ...mark, end: 99 }],
      [{ ...mark, start: 5, end: 4 }],
      [{ ...mark, type: 'UNKNOWN' }],
      [{ ...mark, type: 'custom:' }],
      [{ ...mark, type: 'custom: Sigla' }],
      [{ ...mark, type: `custom:${'x'.repeat(41)}` }],
      [{ ...mark, selected: 'yes' }],
      [null],
      'invalid',
    ]) {
      localStorage.setItem(MANUAL_STORAGE_KEY, JSON.stringify({ document, entities: invalid }));
      expect(await documents.analyze()).toBeTrue();
      expect(documents.analysis()!.entities.some((entity) => entity.manual)).toBeFalse();
    }
    localStorage.setItem(MANUAL_STORAGE_KEY, '{');
    expect(await documents.analyze()).toBeTrue();
    expect(documents.analysis()!.entities.some((entity) => entity.manual)).toBeFalse();
  });

  it('reuses custom categories whatever their case and prefers built-in names in either language', () => {
    const saved = localStorage.getItem('language');
    const language = TestBed.inject(LanguageService);
    try {
      language.setPreference('en');
      expect(documents.addCustomCategory('  Matrícula   escolar ')).toBe(
        'custom:Matrícula escolar',
      );
      expect(documents.addCustomCategory('MATRÍCULA ESCOLAR')).toBe('custom:Matrícula escolar');
      expect(documents.addCustomCategory('names')).toBe('NAME');
      // The label of a built-in category in the other language is that category too.
      expect(documents.addCustomCategory('Saúde')).toBe('HEALTH');
      language.setPreference('pt-PT');
      expect(documents.addCustomCategory('saúde')).toBe('HEALTH');
      expect(documents.addCustomCategory('Names')).toBe('NAME');
      expect(documents.addCustomCategory('   ')).toBe('');
      expect(documents.addCustomCategory('x'.repeat(41))).toBe('');
      expect(documents.addCustomCategory('x'.repeat(40))).toBe(`custom:${'x'.repeat(40)}`);
      expect(documents.customCategories()).toEqual(['Matrícula escolar', 'x'.repeat(40)]);
      documents.clear();
      expect(documents.customCategories().length).toBe(2);
    } finally {
      if (saved === null) localStorage.removeItem('language');
      else localStorage.setItem('language', saved);
      document.documentElement.lang = 'en';
    }
  });

  it('summarizes the current result for its selection and forgets it with the result', async () => {
    expect(await documents.summarize('pt-PT')).toBeFalse();
    await analyzeSelected();
    expect(await documents.summarize('pt-PT')).toBeFalse();
    documents.setEntities(['name-2'], false);
    await documents.anonymize();
    const pending = deferred<string>();
    processor.summarize.and.returnValue(pending.promise);
    const request = documents.summarize('pt-PT');
    expect(documents.summarizing()).toBeTrue();
    expect(await documents.summarize('pt-PT')).toBeFalse();
    const [document, ids, language, signal] = processor.summarize.calls.mostRecent().args;
    expect(document).toBe(documents.analysis()!);
    expect(ids).toEqual(['name-1', 'id-1']);
    expect(language).toBe('pt-PT');
    expect(signal instanceof AbortSignal).toBeTrue();
    expect(documents.processing()).toBeFalse();
    expect(documents.stage()).toBe('results');
    pending.resolve('Um registo com dois dados ocultos.');
    expect(await request).toBeTrue();
    expect(documents.summary()).toBe('Um registo com dois dados ocultos.');
    expect(documents.summaryLanguage()).toBe('pt-PT');
    expect(documents.summarizing()).toBeFalse();
    expect(documents.summaryError()).toBeFalse();
    expect(processor.summarize).toHaveBeenCalledTimes(1);
    documents.returnToReview();
    expect(documents.summary()).toBeNull();
    expect(documents.summaryLanguage()).toBeNull();
    await documents.anonymize();
    expect(documents.summary()).toBeNull();
  });

  it('reports a failed summary, allows a retry and drops a late answer after leaving', async () => {
    await analyzeSelected();
    await documents.anonymize();
    processor.summarize.and.returnValues(
      Promise.reject(new Error('Unavailable')),
      Promise.resolve('   '),
      Promise.resolve('Resumo.'),
    );
    expect(await documents.summarize('en')).toBeFalse();
    expect(documents.summaryError()).toBeTrue();
    expect(documents.summary()).toBeNull();
    expect(documents.result()).not.toBeNull();
    expect(await documents.summarize('en')).toBeFalse();
    expect(documents.summaryError()).toBeTrue();
    expect(await documents.summarize('en')).toBeTrue();
    expect(documents.summaryError()).toBeFalse();
    expect(documents.summary()).toBe('Resumo.');
    documents.returnToReview();
    await documents.anonymize();
    const pending = deferred<string>();
    processor.summarize.and.returnValue(pending.promise);
    const request = documents.summarize('en');
    const signal = processor.summarize.calls.mostRecent().args[3];
    documents.returnToReview();
    expect(signal.aborted).toBeTrue();
    pending.resolve('Tarde.');
    expect(await request).toBeFalse();
    await documents.anonymize();
    expect(documents.summary()).toBeNull();
    expect(documents.summarizing()).toBeFalse();
    expect(documents.summaryError()).toBeFalse();
  });

  it('rejects invalid artifacts and results that do not match the selected occurrences', async () => {
    await analyzeSelected();
    documents.setEntities(['name-1'], false);
    const valid = result(analysis(), ['name-2', 'id-1']);
    for (const invalid of [
      { ...valid, download: { name: 'result.pdf', blob: null as unknown as Blob } },
      { ...valid, originalText: 'Different document' },
      result(),
      { ...valid, entities: [] },
    ]) {
      processor.anonymize.and.resolveTo(invalid);
      expect(await documents.anonymize()).toBeFalse();
      expect(documents.result()).toBeNull();
      expect(documents.error()).toBeTrue();
      expect(documents.stage()).toBe('analysis');
    }
  });
});

describe('Local selected anonymization', () => {
  isolateStoredMarks();

  it('masks only selected occurrences and downloads that exact text', async () => {
    const signal = new AbortController().signal;
    const document = await exampleDocumentProcessor.analyze(
      new File(['untouched'], 'local.pdf'),
      signal,
    );
    expect(new Set(document.entities.map((entity) => entity.type))).toEqual(
      new Set(['NAME', 'AGE', 'ID', 'CONTACT', 'HEALTH']),
    );
    const names = document.entities.filter((entity) => entity.type === 'NAME');
    const selected = [
      names[0].id,
      ...document.entities.filter((entity) => entity.type === 'HEALTH').map((entity) => entity.id),
    ];
    const completed = await exampleDocumentProcessor.anonymize(document, selected, signal);
    expect(completed.anonymizedText).toContain('Nome: [NOME]');
    expect(completed.anonymizedText).toContain('Contacto de emergência: Ana Correia');
    expect(completed.anonymizedText).toContain('NIF: 123456789');
    expect(completed.anonymizedText).toContain('Diagnóstico: [SAÚDE]');
    expect(await completed.download.blob.text()).toBe(completed.anonymizedText);
    expect(completed.entities.map((entity) => entity.id)).toEqual(selected);
  });

  it('summarizes the example in the chosen language without revealing what it masks', async () => {
    const signal = new AbortController().signal;
    const document = await exampleDocumentProcessor.analyze(new File(['x'], 'local.pdf'), signal);
    const pt = await exampleDocumentProcessor.summarize(document, [], 'pt-PT', signal);
    const en = await exampleDocumentProcessor.summarize(document, [], 'en', signal);
    expect(pt).toContain('Ficha de acompanhamento');
    expect(en).toContain('Follow-up record');
    for (const hidden of ['Ana Correia', '34', '123456789', 'Liberdade', 'asma', 'salbutamol']) {
      expect(pt).not.toContain(hidden);
      expect(en).not.toContain(hidden);
    }
    const cancelled = new AbortController();
    cancelled.abort();
    await expectAsync<unknown, unknown>(
      exampleDocumentProcessor.summarize(document, [], 'en', cancelled.signal),
    ).toBeRejected();
  });

  it('masks manual occurrences word by word, keeping punctuation and line breaks', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT_PROCESSOR, useValue: exampleDocumentProcessor }],
    });
    const documents = TestBed.inject(DocumentService);
    documents.select(new File(['untouched'], 'local.pdf'));
    await documents.analyze();
    const text = documents.analysis()!.originalText;
    const heading = 'Ficha de acompanhamento\nNome';
    const start = text.indexOf(heading);
    const label = text.indexOf('Medicação');
    expect(
      documents.addManualEntities(
        [
          { start, end: start + heading.length },
          { start: label, end: label + 'Medicação'.length },
        ],
        'custom:Cabeçalho',
      ),
    ).toEqual(['manual-1', 'manual-2']);
    expect(await documents.anonymize()).toBeTrue();
    const anonymized = documents.result()!.anonymizedText;
    expect(anonymized.startsWith('* * *\n*: [NOME]\n')).toBeTrue();
    expect(anonymized).toContain('\n*: [MEDICAÇÃO]\n');
    expect(documents.result()!.entities.filter((entity) => entity.manual).length).toBe(2);
    expect(await documents.result()!.download.blob.text()).toBe(anonymized);
  });

  it('supports an empty selection without silently masking anything', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT_PROCESSOR, useValue: exampleDocumentProcessor }],
    });
    const documents = TestBed.inject(DocumentService);
    documents.select(new File(['untouched'], 'local.pdf'));
    await documents.analyze();
    documents.selectAll(false);
    expect(await documents.anonymize()).toBeTrue();
    expect(documents.result()!.anonymizedText).toBe(documents.analysis()!.originalText);
    expect(documents.result()!.entities).toEqual([]);
    expect(await documents.result()!.download.blob.text()).toBe(documents.analysis()!.originalText);
  });
});
