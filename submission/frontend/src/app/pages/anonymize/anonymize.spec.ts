import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Anonymize } from './anonymize';
import { DocumentService } from '../../document.service';
import { AnalyzedDocument, DOCUMENT_PROCESSOR, ProcessedDocument } from '../../document-processor';
import { LanguageService } from '../../language.service';

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;

describe('PDF selection', () => {
  let savedLanguage: string | null;

  beforeEach(() => {
    savedLanguage = localStorage.getItem('language');
    localStorage.removeItem('language');
    TestBed.configureTestingModule({ imports: [Anonymize], providers: [provideRouter([])] });
  });

  afterEach(() => {
    if (savedLanguage === null) localStorage.removeItem('language');
    else localStorage.setItem('language', savedLanguage);
    document.documentElement.lang = 'en';
  });

  async function setup() {
    const fixture = TestBed.createComponent(Anonymize);
    await fixture.whenStable();
    return fixture;
  }

  /** Waits for the text view, which replaces a PDF preview that could not be rendered. */
  async function textPanels(
    fixture: ComponentFixture<Anonymize>,
    count: number,
  ): Promise<HTMLElement[]> {
    const root = fixture.nativeElement as HTMLElement;
    const panels = () => Array.from(root.querySelectorAll<HTMLElement>('.paper .document-text'));
    for (let i = 0; i < 100 && panels().length < count; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fixture.whenStable();
    }
    return panels();
  }

  it('rejects non-PDF and empty files and disables analysis without selection', async () => {
    const fixture = await setup();
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const button = fixture.nativeElement.querySelector(
      '.upload-actions button',
    ) as HTMLButtonElement;
    expect(button.disabled).toBeTrue();
    for (const file of [
      new File(['text'], 'document.txt', { type: 'text/plain' }),
      new File([], 'empty.pdf', { type: 'application/pdf' }),
    ]) {
      const data = new DataTransfer();
      data.items.add(file);
      input.files = data.files;
      input.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
      expect(TestBed.inject(DocumentService).file()).toBeNull();
    }
  });

  it('accepts a dropped PDF and lets the user choose another after analysis', async () => {
    const fixture = await setup();
    const data = new DataTransfer();
    data.items.add(new File(['%PDF-demo'], 'sample.pdf', { type: 'application/pdf' }));
    fixture.nativeElement
      .querySelector('.drop-zone')
      .dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true }));
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('sample.pdf');
    expect(fixture.nativeElement.querySelector('.upload-actions button').disabled).toBeFalse();
    fixture.nativeElement.querySelector('.upload-actions button').click();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Review analysis');
    expect(fixture.nativeElement.querySelector('.home-intro')).toBeNull();
    fixture.nativeElement.querySelector('.page-actions .btn-outline-secondary').click();
    await fixture.whenStable();
    expect(TestBed.inject(DocumentService).file()).not.toBeNull();
    expect(TestBed.inject(DocumentService).analysis()).toBeNull();
    expect(TestBed.inject(DocumentService).result()).toBeNull();
    expect(fixture.nativeElement.querySelector('.home-intro')).not.toBeNull();
  });

  it('shows pending processing, disables duplicate submissions and keeps the file available after a failure', async () => {
    let reject!: (reason?: unknown) => void;
    const pending = new Promise<AnalyzedDocument>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const processor = jasmine.createSpy('processor').and.returnValue(pending);
    TestBed.overrideProvider(DOCUMENT_PROCESSOR, { useValue: { analyze: processor } });
    const fixture = await setup();
    const documents = TestBed.inject(DocumentService);
    documents.select(new File(['%PDF-input'], 'report.pdf', { type: 'application/pdf' }));
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector(
      '.upload-actions button',
    ) as HTMLButtonElement;
    button.click();
    fixture.detectChanges();
    expect(button.disabled).toBeTrue();
    expect(button.textContent).toContain(TestBed.inject(LanguageService).text().processing);
    expect(fixture.nativeElement.querySelector('.upload-panel').getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(fixture.nativeElement.querySelector('input[type="file"]').disabled).toBeTrue();
    button.click();
    expect(processor).toHaveBeenCalledTimes(1);
    reject(new Error('Network unavailable'));
    await pending.catch(() => undefined);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
    expect(button.disabled).toBeFalse();
    expect(fixture.nativeElement.textContent).toContain('report.pdf');
    expect(fixture.nativeElement.querySelector('.upload-panel').getAttribute('aria-busy')).toBe(
      'false',
    );
  });

  it('renders arbitrary API content safely, preserves it across languages and downloads the returned file', async () => {
    const originalText = 'Record: Joana <img src=x onerror="alert(1)">\nAccount: 98765';
    const start = originalText.indexOf('Joana');
    const blob = new Blob(['%PDF-anonymized-by-backend'], { type: 'application/pdf' });
    const result: ProcessedDocument = {
      originalText,
      anonymizedText: 'Record: [REDACTED] <script>alert(2)</script>\nAccount: 98765',
      entities: [
        {
          id: 'name-1',
          start,
          end: start + 5,
          type: 'CUSTOM_PERSON',
          replacement: '[REDACTED]',
          reason: 'Identified by the backend',
        },
      ],
      download: { name: 'report-protected.pdf', blob },
      source: 'api',
    };
    TestBed.overrideProvider(DOCUMENT_PROCESSOR, {
      useValue: {
        analyze: () =>
          Promise.resolve({
            id: 'analysis-1',
            originalText,
            entities: result.entities,
            source: 'api',
          }),
        anonymize: () => Promise.resolve(result),
      },
    });
    const fixture = await setup();
    TestBed.inject(DocumentService).select(
      new File(['%PDF-input'], 'report.pdf', { type: 'application/pdf' }),
    );
    await fixture.whenStable();
    fixture.nativeElement.querySelector('.upload-actions button').click();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.document-text')!.textContent).toBe(originalText);
    expect(root.querySelector('.document-text mark')!.textContent).toBe('Joana');
    expect(root.querySelector('.entity-scroll')!.textContent).toContain('Other personal data');
    expect(root.querySelector('.entity-scroll')!.textContent).toContain(
      'Identified by the backend',
    );
    expect(root.querySelector('.paper-brand')).toBeNull();
    root.querySelector<HTMLButtonElement>('.page-actions .btn-primary')!.click();
    await new Promise((resolve) => setTimeout(resolve, 5100));
    await fixture.whenStable();
    const texts = async () => (await textPanels(fixture, 2)).map((element) => element.textContent);
    expect(await texts()).toEqual([originalText, result.anonymizedText]);
    expect(root.querySelector('.paper img, .paper script')).toBeNull();
    TestBed.inject(LanguageService).setPreference('pt-PT');
    await fixture.whenStable();
    expect(await texts()).toEqual([originalText, result.anonymizedText]);
    expect(root.querySelector('#results-title')!.textContent).toBe('Comparar as duas versões');
    const createUrl = spyOn(URL, 'createObjectURL').and.returnValue('blob:backend-document');
    const revokeUrl = spyOn(URL, 'revokeObjectURL');
    let downloadedName: string | undefined;
    let downloadedHref: string | undefined;
    spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(function (this: HTMLAnchorElement) {
      downloadedName = this.download;
      downloadedHref = this.href;
    });
    root.querySelector<HTMLButtonElement>('.page-actions .btn-primary')!.click();
    expect(createUrl).toHaveBeenCalledOnceWith(blob);
    expect(downloadedName).toBe('report-protected.pdf');
    expect(downloadedHref).toBe('blob:backend-document');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revokeUrl).toHaveBeenCalledOnceWith('blob:backend-document');
  });

  it('synchronizes total, category and individual selection for repeated names', async () => {
    const analysis: AnalyzedDocument = {
      id: 'review-1',
      originalText: 'Ana, Ana, NIF 12345',
      source: 'api',
      entities: [
        { id: 'name-1', start: 0, end: 3, type: 'NAME', replacement: '*' },
        { id: 'name-2', start: 5, end: 8, type: 'NAME', replacement: '*' },
        { id: 'id-1', start: 14, end: 19, type: 'ID', replacement: '*' },
      ],
    };
    TestBed.overrideProvider(DOCUMENT_PROCESSOR, {
      useValue: { analyze: () => Promise.resolve(analysis) },
    });
    const fixture = await setup();
    const documents = TestBed.inject(DocumentService);
    documents.select(new File(['%PDF-input'], 'report.pdf', { type: 'application/pdf' }));
    await documents.analyze();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const all = root.querySelector<HTMLInputElement>('.select-all input')!;
    const names = root.querySelector<HTMLInputElement>('.category-group .category-heading input')!;
    const first = root.querySelector<HTMLInputElement>('[data-entity-id="name-1"]')!;
    const second = root.querySelector<HTMLInputElement>('[data-entity-id="name-2"]')!;
    expect(all.checked).toBeTrue();
    // Categories start open; the toggle collapses one and makes its items inert.
    const toggle = root.querySelector<HTMLButtonElement>('.category-toggle')!;
    expect(root.querySelectorAll('.category-group.is-open').length).toBe(2);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    await fixture.whenStable();
    expect(root.querySelectorAll('.category-group.is-open').length).toBe(1);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('.category-items[inert]')).not.toBeNull();
    toggle.click();
    await fixture.whenStable();
    expect(root.querySelectorAll('.category-group.is-open').length).toBe(2);
    first.click();
    await fixture.whenStable();
    expect(documents.selectedEntityIds()).toEqual(['name-2', 'id-1']);
    expect(second.checked).toBeTrue();
    expect(names.indeterminate).toBeTrue();
    expect(all.indeterminate).toBeTrue();
    expect(root.querySelectorAll('.category-highlight.is-selected').length).toBe(2);
    names.click();
    await fixture.whenStable();
    expect(documents.selectedCount()).toBe(3);
    names.click();
    await fixture.whenStable();
    expect(documents.selectedEntityIds()).toEqual(['id-1']);
    all.click();
    await fixture.whenStable();
    expect(documents.selectedCount()).toBe(3);
    all.click();
    await fixture.whenStable();
    expect(documents.selectedCount()).toBe(0);
    expect(names.checked).toBeFalse();
  });

  it('displays all twelve API categories with Font Awesome icons and translated labels', async () => {
    const types = [
      'NAME',
      'ID',
      'CONTACT',
      'DOB',
      'FINANCIAL',
      'HEALTH',
      'SPECIAL',
      'PRIVATE_LIFE',
      'AGE',
      'OCCUPATION',
      'CLINICIAN',
      'SEX',
    ];
    const originalText = types.join(' ');
    const analysis: AnalyzedDocument = {
      id: 'categories',
      originalText,
      source: 'api',
      entities: types.map((type) => ({
        id: type,
        type,
        start: originalText.indexOf(type),
        end: originalText.indexOf(type) + type.length,
        replacement: '*',
      })),
    };
    TestBed.overrideProvider(DOCUMENT_PROCESSOR, {
      useValue: { analyze: () => Promise.resolve(analysis) },
    });
    const fixture = await setup();
    const documents = TestBed.inject(DocumentService);
    documents.select(new File(['%PDF-input'], 'report.pdf', { type: 'application/pdf' }));
    await documents.analyze();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('.category-group').length).toBe(12);
    expect(root.querySelectorAll('.category-icon svg path[d]').length).toBe(12);
    expect(root.querySelectorAll('.entity-option input:checked').length).toBe(12);
    TestBed.inject(LanguageService).setPreference('pt-PT');
    await fixture.whenStable();
    expect(root.querySelector('app-entity-selection')!.textContent).toContain('Saúde');
    expect(root.querySelector('.document-text')!.textContent).toBe(originalText);
  });

  it('handles a response containing no personal data without showing sample entities', async () => {
    const result: ProcessedDocument = {
      originalText: 'A public announcement.',
      anonymizedText: 'A public announcement.',
      entities: [],
      download: { name: 'announcement.txt', blob: new Blob(['A public announcement.']) },
      source: 'api',
    };
    TestBed.overrideProvider(DOCUMENT_PROCESSOR, {
      useValue: {
        analyze: () =>
          Promise.resolve({
            id: 'empty-1',
            originalText: result.originalText,
            entities: [],
            source: 'api',
          }),
        anonymize: () => Promise.resolve(result),
      },
    });
    const fixture = await setup();
    TestBed.inject(DocumentService).select(
      new File(['%PDF-input'], 'announcement.pdf', { type: 'application/pdf' }),
    );
    await fixture.whenStable();
    fixture.nativeElement.querySelector('.upload-actions button').click();
    await fixture.whenStable();
    expect((await textPanels(fixture, 1))[0].textContent).toBe(result.originalText);
    expect(fixture.nativeElement.querySelector('.empty-entities')).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.entity-option').length).toBe(0);
    expect(fixture.nativeElement.querySelectorAll('mark').length).toBe(0);
  });
});
