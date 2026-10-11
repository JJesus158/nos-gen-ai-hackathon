import { TestBed } from '@angular/core/testing';
import { createApiProcessor } from './document-api';
import { AnalyzedDocument, DOCUMENT_API_URL, DOCUMENT_PROCESSOR } from './document-processor';

function analysisBody() {
  return {
    id: 'analysis/id 1',
    originalText: 'Name: Joana; ID: 123',
    entities: [
      { id: 'name-1', start: 6, end: 11, type: 'NAME', replacement: '[NAME]' },
      { id: 'id-1', start: 17, end: 20, type: 'ID', replacement: '[ID]' },
    ],
  };
}

function completedBody(contentBase64 = btoa('%PDF-result')) {
  return {
    anonymizedText: 'Name: [NAME]; ID: 123',
    download: { name: 'protected.pdf', mediaType: 'application/pdf', contentBase64 },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Two-stage document API adapter', () => {
  const endpoint = '/api/documents';
  let fetchRequest: jasmine.Spy;
  let file: File;
  let controller: AbortController;
  let analyzed: AnalyzedDocument;

  beforeEach(() => {
    fetchRequest = spyOn(window, 'fetch');
    file = new File(['%PDF-input'], 'original.pdf', { type: 'application/pdf' });
    controller = new AbortController();
    analyzed = { ...analysisBody(), source: 'api' };
  });

  function reply(body: unknown, status = 200): void {
    fetchRequest.and.resolveTo(jsonResponse(body, status));
  }

  it('uploads once for analysis then sends exactly the selected occurrence IDs to generate the file', async () => {
    fetchRequest.and.returnValues(
      Promise.resolve(jsonResponse(analysisBody())),
      Promise.resolve(jsonResponse(completedBody())),
    );
    const processor = createApiProcessor(`${endpoint}/`);
    const analysis = await processor.analyze(file, controller.signal);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    const [analysisUrl, analysisOptions] = fetchRequest.calls.argsFor(0) as [string, RequestInit];
    expect(analysisUrl).toBe('/api/documents/analyze');
    expect(analysisOptions.method).toBe('POST');
    expect(analysisOptions.signal).toBe(controller.signal);
    expect(analysisOptions.body instanceof FormData).toBeTrue();
    const uploaded = (analysisOptions.body as FormData).get('file') as File;
    expect(uploaded.name).toBe(file.name);
    expect(await uploaded.text()).toBe(await file.text());
    const fields: string[] = [];
    (analysisOptions.body as FormData).forEach((_value, key) => fields.push(key));
    expect(fields).toEqual(['file']);
    expect(new Headers(analysisOptions.headers).get('Accept')).toBe('application/json');
    expect(new Headers(analysisOptions.headers).has('Content-Type')).toBeFalse();
    expect(analysis).toEqual(analyzed);

    const completed = await processor.anonymize(analysis, ['name-1'], controller.signal);
    expect(fetchRequest).toHaveBeenCalledTimes(2);
    const [url, options] = fetchRequest.calls.argsFor(1) as [string, RequestInit];
    expect(url).toBe('/api/documents/analysis%2Fid%201/anonymize');
    expect(options.method).toBe('POST');
    expect(options.signal).toBe(controller.signal);
    expect(new Headers(options.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(options.body as string)).toEqual({ selectedEntityIds: ['name-1'] });
    expect(completed.originalText).toBe(analysis.originalText);
    expect(completed.entities).toEqual([analysis.entities[0]]);
    expect(completed.anonymizedText).toContain('ID: 123');
    expect(completed.source).toBe('api');
  });

  it('preserves every binary byte and the filename of the generated document', async () => {
    const bytes = [0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80];
    reply(completedBody(btoa(String.fromCharCode(...bytes))));
    const result = await createApiProcessor(endpoint).anonymize(
      analyzed,
      ['name-1'],
      controller.signal,
    );
    expect(result.download.name).toBe('protected.pdf');
    expect(result.download.blob.type).toBe('application/pdf');
    expect(Array.from(new Uint8Array(await result.download.blob.arrayBuffer()))).toEqual(bytes);
  });

  it('decodes UTF-8 bytes without changing accented text or the returned filename', async () => {
    const text = 'Informação anonimizada: João — [PESSOA].';
    const bytes = new TextEncoder().encode(text);
    reply({
      anonymizedText: text,
      download: {
        name: 'informação-protegida.txt',
        mediaType: 'text/plain;charset=utf-8',
        contentBase64: btoa(String.fromCharCode(...bytes)),
      },
    });
    const result = await createApiProcessor(endpoint).anonymize(
      analyzed,
      ['name-1'],
      controller.signal,
    );
    expect(await result.download.blob.text()).toBe(text);
    expect(result.download.name).toBe('informação-protegida.txt');
    expect(result.download.blob.type).toBe('text/plain;charset=utf-8');
  });

  it('sends an explicit empty selection instead of treating it as select all', async () => {
    reply({ ...completedBody(), anonymizedText: analyzed.originalText });
    const result = await createApiProcessor(endpoint).anonymize(analyzed, [], controller.signal);
    expect(JSON.parse(fetchRequest.calls.mostRecent().args[1].body)).toEqual({
      selectedEntityIds: [],
    });
    expect(result.entities).toEqual([]);
    expect(result.anonymizedText).toBe(analyzed.originalText);
  });

  it('sends selected manual occurrences as ranges, apart from the detected IDs', async () => {
    const processor = createApiProcessor(endpoint);
    const document: AnalyzedDocument = {
      ...analyzed,
      entities: [
        { id: 'manual-2', start: 0, end: 4, type: 'custom:Campo', replacement: '*', manual: true },
        analyzed.entities[0],
        { id: 'manual-1', start: 13, end: 15, type: 'ID', replacement: '*', manual: true },
        analyzed.entities[1],
      ],
    };
    const body = () => JSON.parse(fetchRequest.calls.mostRecent().args[1].body);
    fetchRequest.and.callFake(async () => jsonResponse(completedBody()));
    const all = ['manual-2', 'name-1', 'manual-1', 'id-1'];
    const completed = await processor.anonymize(document, all, controller.signal);
    expect(body()).toEqual({
      selectedEntityIds: ['name-1', 'id-1'],
      manualEntities: [
        { start: 0, end: 4, type: 'custom:Campo' },
        { start: 13, end: 15, type: 'ID' },
      ],
    });
    expect(completed.entities).toEqual(document.entities);
    await processor.anonymize(document, ['manual-1', 'name-1'], controller.signal);
    expect(body()).toEqual({
      selectedEntityIds: ['name-1'],
      manualEntities: [{ start: 13, end: 15, type: 'ID' }],
    });
    await processor.anonymize(document, ['id-1'], controller.signal);
    expect(Object.keys(body())).toEqual(['selectedEntityIds']);
    expect(body().selectedEntityIds).toEqual(['id-1']);
  });

  it('asks for a summary with the same selection and the language, and checks the answer', async () => {
    const processor = createApiProcessor(endpoint);
    const document: AnalyzedDocument = {
      ...analyzed,
      entities: [
        analyzed.entities[0],
        { id: 'manual-1', start: 13, end: 15, type: 'ID', replacement: '*', manual: true },
        analyzed.entities[1],
      ],
    };
    reply({ summary: '  Um registo com um nome e um identificador ocultos. ' });
    const summary = await processor.summarize(
      document,
      ['name-1', 'manual-1'],
      'pt-PT',
      controller.signal,
    );
    expect(summary).toBe('  Um registo com um nome e um identificador ocultos. ');
    const [url, options] = fetchRequest.calls.mostRecent().args as [string, RequestInit];
    expect(url).toBe('/api/documents/analysis%2Fid%201/summarize');
    expect(options.method).toBe('POST');
    expect(options.signal).toBe(controller.signal);
    expect(new Headers(options.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(options.body as string)).toEqual({
      selectedEntityIds: ['name-1'],
      manualEntities: [{ start: 13, end: 15, type: 'ID' }],
      language: 'pt-PT',
    });
    for (const body of [{}, { summary: '' }, { summary: '   ' }, { summary: 42 }, null]) {
      reply(body);
      await expectAsync<unknown, unknown>(
        processor.summarize(document, ['name-1'], 'en', controller.signal),
      ).toBeRejected();
    }
    reply({ message: 'Summary failed' }, 500);
    await expectAsync<unknown, unknown>(
      processor.summarize(document, ['name-1'], 'en', controller.signal),
    ).toBeRejected();
  });

  it('rejects HTTP failures and invalid JSON in either stage', async () => {
    const processor = createApiProcessor(endpoint);
    for (const run of [
      () => processor.analyze(file, controller.signal),
      () => processor.anonymize(analyzed, ['name-1'], controller.signal),
    ]) {
      reply({ message: 'Processing unavailable' }, 503);
      await expectAsync<unknown, unknown>(run()).toBeRejected();
      fetchRequest.and.resolveTo(new Response('{invalid json', { status: 200 }));
      await expectAsync<unknown, unknown>(run()).toBeRejected();
    }
  });

  it('rejects malformed analysis response fields', async () => {
    for (const body of [
      null,
      { ...analysisBody(), id: '' },
      { ...analysisBody(), originalText: 123 },
      { ...analysisBody(), entities: null },
    ]) {
      reply(body);
      await expectAsync(
        createApiProcessor(endpoint).analyze(file, controller.signal),
      ).toBeRejected();
    }
  });

  it('rejects malformed generation fields and invalid base64 data', async () => {
    for (const body of [
      null,
      { ...completedBody(), anonymizedText: 123 },
      { ...completedBody(), download: null },
      { ...completedBody(), download: { ...completedBody().download, name: '' } },
      { ...completedBody(), download: { ...completedBody().download, mediaType: 123 } },
      completedBody('**not-base64**'),
    ]) {
      reply(body);
      await expectAsync(
        createApiProcessor(endpoint).anonymize(analyzed, ['name-1'], controller.signal),
      ).toBeRejected();
    }
  });

  it('forwards cancellation in both stages and never starts already cancelled work', async () => {
    const processor = createApiProcessor(endpoint);
    for (const run of [
      (signal: AbortSignal) => processor.analyze(file, signal),
      (signal: AbortSignal) => processor.anonymize(analyzed, ['name-1'], signal),
    ]) {
      fetchRequest.and.callFake(
        (_url: RequestInfo | URL, options?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            options!.signal!.addEventListener(
              'abort',
              () => reject(new DOMException('Cancelled', 'AbortError')),
              { once: true },
            );
          }),
      );
      const cancellation = new AbortController();
      const request = run(cancellation.signal);
      cancellation.abort();
      await expectAsync<unknown, unknown>(request).toBeRejectedWith(
        jasmine.objectContaining({ name: 'AbortError' }),
      );
      fetchRequest.calls.reset();
      await expectAsync<unknown, unknown>(run(cancellation.signal)).toBeRejected();
      expect(fetchRequest).not.toHaveBeenCalled();
    }
  });

  it('selects the HTTP processor when the API base URL is configured', async () => {
    reply(analysisBody());
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT_API_URL, useValue: endpoint }],
    });
    const processor = TestBed.inject(DOCUMENT_PROCESSOR);
    expect((await processor.analyze(file, controller.signal)).source).toBe('api');
    expect(fetchRequest.calls.mostRecent().args[0]).toBe('/api/documents/analyze');
  });
});
