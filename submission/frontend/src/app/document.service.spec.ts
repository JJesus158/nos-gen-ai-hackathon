import { TestBed } from '@angular/core/testing';
import {
  AnalyzedDocument,
  DOCUMENT_PROCESSOR,
  DocumentProcessor,
  ProcessedDocument,
} from './document-processor';
import { DocumentService } from './document.service';
import { exampleDocumentProcessor } from './example-document';


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

  beforeEach(() => {
    processor = jasmine.createSpyObj<DocumentProcessor>('processor', ['analyze', 'anonymize']);
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
    expect(documents.stage()).toBe('document');
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
    expect(documents.stage()).toBe('document');
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
