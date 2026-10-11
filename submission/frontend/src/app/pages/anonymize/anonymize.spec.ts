import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Anonymize } from './anonymize';
import { DocumentService } from '../../document.service';
import { AnalyzedDocument, DOCUMENT_PROCESSOR, ProcessedDocument } from '../../document-processor';
import { LanguageService } from '../../language.service';
import { textRange } from '../../manual-selection';
import { exampleDocumentProcessor } from '../../example-document';
import { MANUAL_STORAGE_KEY } from '../../manual-storage';

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;

describe('PDF selection', () => {
  let savedLanguage: string | null;
  let savedMarks: string | null;

  beforeEach(() => {
    savedLanguage = localStorage.getItem('language');
    savedMarks = localStorage.getItem(MANUAL_STORAGE_KEY);
    localStorage.removeItem('language');
    localStorage.removeItem(MANUAL_STORAGE_KEY);
    TestBed.configureTestingModule({ imports: [Anonymize], providers: [provideRouter([])] });
  });

  afterEach(() => {
    for (const [key, value] of [
      ['language', savedLanguage],
      [MANUAL_STORAGE_KEY, savedMarks],
    ]) {
      if (value === null) localStorage.removeItem(key!);
      else localStorage.setItem(key!, value!);
    }
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
    // Categories start closed; the toggle opens one and keeps the other collapsed.
    const toggle = root.querySelector<HTMLButtonElement>('.category-toggle')!;
    expect(root.querySelectorAll('.category-group.is-open').length).toBe(0);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    await fixture.whenStable();
    expect(root.querySelectorAll('.category-group.is-open').length).toBe(1);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('.category-items[inert]')).not.toBeNull();
    toggle.click();
    await fixture.whenStable();
    expect(root.querySelectorAll('.category-group.is-open').length).toBe(0);
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

  describe('marking selected text', () => {
    async function review() {
      const fixture = await setup();
      const documents = TestBed.inject(DocumentService);
      documents.select(new File(['%PDF-demo'], 'sample.pdf', { type: 'application/pdf' }));
      await documents.analyze();
      await fixture.whenStable();
      return { fixture, documents, root: fixture.nativeElement as HTMLElement };
    }

    /** Selects the first occurrence of `value` in the preview, like a user dragging over it. */
    function select(fixture: ComponentFixture<Anonymize>, value: string): HTMLElement {
      const container = fixture.nativeElement.querySelector('.document-text') as HTMLElement;
      const start = container.textContent!.indexOf(value);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(textRange(container, start, start + value.length)!);
      return container;
    }

    async function selectText(fixture: ComponentFixture<Anonymize>, value: string) {
      select(fixture, value).dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await fixture.whenStable();
    }

    const dialog = (root: HTMLElement) =>
      root.querySelector<HTMLElement>('app-manual-entity-form [role="dialog"]');
    const preview = (root: HTMLElement) => root.querySelector('.preview-panel .paper-scroll');
    /** A dismissed form stays in the layout, hidden, until a new selection replaces it. */
    const hidden = (root: HTMLElement) =>
      root.querySelector('app-manual-entity-form')?.classList.contains('is-hidden') ?? null;

    afterEach(() => document.getSelection()?.removeAllRanges());

    it('categorizes selected text, which is then listed, highlighted and masked', async () => {
      const { fixture, documents, root } = await review();
      const text = documents.analysis()!.originalText;
      expect(root.querySelector('#manual-hint')!.textContent).toBe(
        'Select text in the document to mark data that was not identified.',
      );
      await selectText(fixture, 'compan');
      const form = dialog(root)!;
      expect(form.closest('.paper')).not.toBeNull();
      expect(form.closest('.document-text')).toBeNull();
      expect(form.getAttribute('aria-labelledby')).toBe(form.querySelector('strong')!.id);
      expect(form.querySelector('strong')!.textContent).toBe('Mark as personal data');
      expect(form.querySelector('q')!.textContent).toBe('acompanhamento');
      expect(root.querySelector('.document-text')!.textContent).toBe(text);
      const pending = root.querySelector('.pending-highlight.is-open')!;
      expect(pending.textContent).toBe('acompanhamento');
      const paper = root.querySelector('.preview-panel .paper')!.getBoundingClientRect();
      const box = form.getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(pending.getBoundingClientRect().bottom);
      expect(box.top).toBeLessThan(pending.getBoundingClientRect().bottom + 12);
      expect(box.left).toBeGreaterThanOrEqual(paper.left);
      expect(box.right).toBeLessThanOrEqual(paper.right);
      expect(document.getSelection()!.rangeCount).toBe(0);
      const category = form.querySelector('select')!;
      expect(document.activeElement).toBe(category);
      expect(category.labels![0].textContent).toBe('Category');
      expect(category.value).toBe('NAME');
      expect(Array.from(category.options, (option) => option.textContent!.trim())).toEqual([
        'Names',
        'Identifiers',
        'Contact details',
        'Dates of birth',
        'Financial data',
        'Health',
        'Sensitive data',
        'Private life',
        'Ages',
        'Occupations',
        'Healthcare professionals',
        'Sex and gender',
        'New category…',
      ]);
      expect(form.querySelector('input')).toBeNull();
      category.value = 'ID';
      category.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      await fixture.whenStable();
      expect(dialog(root)).toBeNull();
      expect(root.querySelector('.pending-highlight')).toBeNull();
      expect(document.activeElement).toBe(preview(root));
      expect(root.querySelector('.manual-status')!.textContent).toBe('Added to Identifiers');
      const start = text.indexOf('acompanhamento');
      expect(documents.analysis()!.entities.find((entity) => entity.manual)).toEqual({
        id: 'manual-1',
        start,
        end: start + 'acompanhamento'.length,
        type: 'ID',
        replacement: '*',
        manual: true,
      });
      expect(documents.isSelected('manual-1')).toBeTrue();
      const marks = root.querySelectorAll('.document-text .category-highlight.is-selected');
      expect(Array.from(marks, (mark) => mark.textContent)).toContain('acompanhamento');
      expect(root.querySelector('.document-text')!.textContent).toBe(text);
      const item = root.querySelector('[data-entity-id="manual-1"]')!.closest('.entity-item')!;
      expect(
        item.closest('.category-group')!.querySelector('.category-heading')!.textContent,
      ).toContain('Identifiers');
      expect(item.querySelector('strong')!.textContent).toBe('acompanhamento');
      expect(item.querySelector('.manual-badge')!.textContent).toBe('Added by you');
      expect(item.querySelector('label button')).toBeNull();
      expect(item.querySelector('button')!.getAttribute('aria-label')).toBe(
        'Remove acompanhamento',
      );
      expect(await documents.anonymize()).toBeTrue();
      expect(documents.result()!.anonymizedText.split('\n')[0]).toBe('Ficha de *');
    });

    it('creates a new category from the form and offers it for the next selection', async () => {
      const { fixture, documents, root } = await review();
      await selectText(fixture, 'Medicação:');
      let form = dialog(root)!;
      expect(form.querySelector('q')!.textContent).toBe('Medicação');
      const category = form.querySelector('select')!;
      // Chosen with the mouse: focus moves on to the name.
      category.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      category.value = 'new';
      category.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      const name = form.querySelector<HTMLInputElement>('input[type="text"]')!;
      expect(document.activeElement).toBe(name);
      expect(name.labels![0].textContent).toBe('Category name');
      expect(name.required).toBeTrue();
      expect(name.maxLength).toBe(40);
      const add = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      expect(add.disabled).toBeTrue();
      name.value = '   ';
      name.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      expect(add.disabled).toBeTrue();
      name.value = '  Campo   clínico ';
      name.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      expect(add.disabled).toBeFalse();
      // What pressing Enter in the name field does.
      form.querySelector('form')!.requestSubmit();
      await fixture.whenStable();
      expect(dialog(root)).toBeNull();
      expect(documents.customCategories()).toEqual(['Campo clínico']);
      expect(documents.analysis()!.entities.find((entity) => entity.manual)!.type).toBe(
        'custom:Campo clínico',
      );
      expect(root.querySelector('.manual-status')!.textContent).toBe('Added to Campo clínico');
      const headings = Array.from(
        root.querySelectorAll('.category-heading'),
        (heading) => heading.querySelector('span:not([class])')!.textContent,
      );
      expect(headings).toContain('Campo clínico');
      await selectText(fixture, 'Diagnóstico');
      form = dialog(root)!;
      const next = form.querySelector('select')!;
      expect(next.value).toBe('custom:Campo clínico');
      expect(next.options[next.options.length - 2].textContent!.trim()).toBe('Campo clínico');
    });

    it('only explains why text overlapping identified data cannot be marked', async () => {
      const { fixture, documents, root } = await review();
      const before = documents.analysis();
      await selectText(fixture, 'na Cor');
      const form = dialog(root)!;
      const message = form.querySelector('.overlap-message')!;
      expect(message.textContent).toBe(
        'This text overlaps data that is already identified. Select only the missing part.',
      );
      expect(form.getAttribute('aria-labelledby')).toBe(message.id);
      expect(form.querySelector('select, q, input')).toBeNull();
      expect(root.querySelector('.pending-highlight')).toBeNull();
      const close = form.querySelector('button')!;
      expect(close.textContent!.trim()).toBe('Close');
      expect(document.activeElement).toBe(close);
      close.click();
      await fixture.whenStable();
      expect(dialog(root)).toBeNull();
      expect(document.activeElement).toBe(preview(root));
      expect(documents.analysis()).toBe(before);
    });

    it('marks the other occurrences too, closes with Escape and follows the language', async () => {
      const { fixture, documents, root } = await review();
      TestBed.inject(LanguageService).setPreference('pt-PT');
      await fixture.whenStable();
      expect(root.querySelector('#manual-hint')!.textContent).toBe(
        'Selecione texto para marcar dados não identificados.',
      );
      await selectText(fixture, ' de ');
      let form = dialog(root)!;
      expect(form.querySelector('label')!.textContent).toBe('Categoria');
      const others = form.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      expect(others.checked).toBeTrue();
      expect(others.labels![0].textContent).toBe('Marcar também a outra ocorrência');
      form
        .querySelector('select')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await fixture.whenStable();
      expect(dialog(root)).toBeNull();
      expect(root.querySelector('.pending-highlight')).toBeNull();
      expect(document.activeElement).toBe(preview(root));
      expect(documents.analysis()!.entities.some((entity) => entity.manual)).toBeFalse();
      await selectText(fixture, ' de ');
      form = dialog(root)!;
      form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      await fixture.whenStable();
      const text = documents.analysis()!.originalText;
      const manual = documents.analysis()!.entities.filter((entity) => entity.manual);
      expect(manual.map((entity) => [entity.start, text.slice(entity.start, entity.end)])).toEqual([
        [text.indexOf(' de ') + 1, 'de'],
        [text.lastIndexOf(' de ') + 1, 'de'],
      ]);
      expect(root.querySelector('.manual-status')!.textContent).toBe('Adicionado a Nomes');
      const remove = root.querySelector<HTMLButtonElement>('.remove-manual')!;
      expect(remove.getAttribute('aria-label')).toBe('Remover de');
      remove.click();
      await fixture.whenStable();
      expect(documents.analysis()!.entities.filter((entity) => entity.manual).length).toBe(1);
      expect(root.querySelectorAll('.manual-badge').length).toBe(1);
      expect(document.activeElement).toBe(root.querySelector('.entity-scroll'));
    });

    it('reads keyboard selections once Shift is released, each in a new form', async () => {
      const { fixture, root } = await review();
      await selectText(fixture, 'Medicação');
      const category = dialog(root)!.querySelector('select')!;
      category.value = 'new';
      category.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      expect(dialog(root)!.querySelector('input[type="text"]')).not.toBeNull();
      const region = preview(root)!;
      select(fixture, 'Diagnóstico');
      region.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
      );
      await fixture.whenStable();
      expect(dialog(root)!.querySelector('q')!.textContent).toBe('Medicação');
      region.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
      await fixture.whenStable();
      const form = dialog(root)!;
      expect(form.querySelector('q')!.textContent).toBe('Diagnóstico');
      expect(form.querySelector('select')!.value).toBe('NAME');
      expect(form.querySelector('input[type="text"]')).toBeNull();
      expect(document.activeElement).toBe(form.querySelector('select'));
    });

    it('hides the form on a press elsewhere without moving the layout, until a new selection', async () => {
      const { fixture, documents, root } = await review();
      await selectText(fixture, 'Medicação');
      const form = root.querySelector('app-manual-entity-form');
      root
        .querySelector('.entity-scroll')!
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await fixture.whenStable();
      expect(hidden(root)).toBeTrue();
      expect(root.querySelector('app-manual-entity-form')).toBe(form);
      expect(root.querySelector('.pending-highlight:not(.is-open)')).not.toBeNull();
      // A release that selected nothing, such as the first click of a double-click, keeps it.
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await fixture.whenStable();
      expect(root.querySelector('app-manual-entity-form')).toBe(form);
      expect(hidden(root)).toBeTrue();

      // The next selection replaces it with a new, visible form.
      await selectText(fixture, 'Diagnóstico');
      expect(root.querySelector('app-manual-entity-form')).not.toBe(form);
      expect(hidden(root)).toBeFalse();
      expect(dialog(root)!.querySelector('q')!.textContent).toBe('Diagnóstico');

      // A press in the text hides it too and leaves the text nodes alone.
      const container = root.querySelector<HTMLElement>('.document-text')!;
      container.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await fixture.whenStable();
      expect(hidden(root)).toBeTrue();
      expect(root.querySelector('.document-text')!.textContent).toBe(
        documents.analysis()!.originalText,
      );

      // The interface keeps processing visible for a while, so it is rendered at least once.
      const request = documents.anonymize(100);
      await fixture.whenStable();
      expect(documents.processing()).toBeTrue();
      expect(dialog(root)).toBeNull();
      expect(await request).toBeTrue();
      documents.returnToReview();
      await fixture.whenStable();
      expect(root.querySelector('.analysis-grid')).not.toBeNull();
      expect(dialog(root)).toBeNull();
      expect(root.querySelector('.pending-highlight')).toBeNull();
    });

    it('waits for touch selections, keeps the form during a scroll and hides it on a tap', async () => {
      const { fixture, root } = await review();
      const container = root.querySelector<HTMLElement>('.document-text')!;
      container.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }),
      );
      select(fixture, 'Diagnóstico');
      container.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }),
      );
      await fixture.whenStable();
      expect(dialog(root)).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 700));
      await fixture.whenStable();
      expect(dialog(root)!.querySelector('q')!.textContent).toBe('Diagnóstico');

      // A swipe outside the form becomes a scroll: the browser cancels the pointer.
      const list = root.querySelector<HTMLElement>('.entity-scroll')!;
      list.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
      list.dispatchEvent(
        new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch' }),
      );
      await new Promise((resolve) => setTimeout(resolve, 700));
      await fixture.whenStable();
      expect(hidden(root)).toBeFalse();

      // A tap outside the form dismisses it.
      list.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
      list.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
      await fixture.whenStable();
      expect(hidden(root)).toBeTrue();
    });

    it('closes with Escape after a click on its text, and hides when focus leaves it', async () => {
      const { fixture, root } = await review();
      await selectText(fixture, 'Medicação');
      let form = dialog(root)!;
      // A click on the title focuses the dialog itself, where Escape is handled.
      expect(form.getAttribute('tabindex')).toBe('-1');
      form.focus();
      form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await fixture.whenStable();
      expect(dialog(root)).toBeNull();
      expect(document.activeElement).toBe(preview(root));

      await selectText(fixture, 'Medicação');
      form = dialog(root)!;
      const category = form.querySelector('select')!;
      // Shift+Tab back to the preview keeps it; Tab on to the list hides it.
      category.dispatchEvent(
        new FocusEvent('focusout', { bubbles: true, relatedTarget: preview(root) }),
      );
      await fixture.whenStable();
      expect(hidden(root)).toBeFalse();
      category.dispatchEvent(
        new FocusEvent('focusout', {
          bubbles: true,
          relatedTarget: root.querySelector('.entity-scroll'),
        }),
      );
      await fixture.whenStable();
      expect(hidden(root)).toBeTrue();
    });

    it('ignores shortcuts such as Ctrl+A in the preview', async () => {
      const { fixture, root } = await review();
      const container = root.querySelector<HTMLElement>('.document-text')!;
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.selectAllChildren(container);
      const region = preview(root)!;
      region.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', ctrlKey: true, bubbles: true }));
      region.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
      await fixture.whenStable();
      expect(dialog(root)).toBeNull();
      expect(selection.isCollapsed).toBeFalse();
    });

    it('offers to select listed data that is not selected instead of marking it again', async () => {
      const { fixture, documents, root } = await review();
      documents.setEntities(['entity-1'], false);
      await fixture.whenStable();
      await selectText(fixture, 'na Cor');
      const form = dialog(root)!;
      expect(form.querySelector('.overlap-message')!.textContent!.trim()).toBe(
        'This text is already in the list, but it is not selected for anonymization.',
      );
      const action = form.querySelector<HTMLButtonElement>('.btn-primary')!;
      expect(action.textContent!.trim()).toBe('Select it');
      expect(document.activeElement).toBe(action);
      action.click();
      await fixture.whenStable();
      expect(documents.isSelected('entity-1')).toBeTrue();
      expect(dialog(root)).toBeNull();
      expect(documents.analysis()!.entities.some((entity) => entity.manual)).toBeFalse();
    });

    it('moves focus to a new category name only when it was chosen with the pointer', async () => {
      const { fixture, root } = await review();
      await selectText(fixture, 'Medicação');
      const category = dialog(root)!.querySelector('select')!;
      // Arrow keys and End pass through "New category…" on a closed select.
      category.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      category.value = 'new';
      category.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      expect(dialog(root)!.querySelector('input[type="text"]')).not.toBeNull();
      expect(document.activeElement).toBe(category);
      category.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      category.value = 'NAME';
      category.dispatchEvent(new Event('change'));
      category.value = 'new';
      category.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      expect(document.activeElement).toBe(dialog(root)!.querySelector('input[type="text"]'));
    });

    it('announces a category name exactly as typed', async () => {
      const { fixture, root } = await review();
      await selectText(fixture, 'Medicação');
      const form = dialog(root)!;
      const category = form.querySelector('select')!;
      category.value = 'new';
      category.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      const name = form.querySelector<HTMLInputElement>('input[type="text"]')!;
      name.value = 'Fees $$ and $&';
      name.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      await fixture.whenStable();
      expect(root.querySelector('.manual-status')!.textContent).toBe('Added to Fees $$ and $&');
    });
  });

  describe('summarizing the result', () => {
    async function results() {
      const fixture = await setup();
      const documents = TestBed.inject(DocumentService);
      documents.select(new File(['%PDF-demo'], 'ficha.pdf', { type: 'application/pdf' }));
      await documents.analyze();
      await documents.anonymize();
      await fixture.whenStable();
      return { fixture, documents, root: fixture.nativeElement as HTMLElement };
    }

    const summarizeButton = (root: HTMLElement) =>
      root.querySelector<HTMLButtonElement>('.summarize-button');
    /** Both panels fall back to text (fake PDF, .txt download) once rendering has failed. */
    const papers = async (fixture: ComponentFixture<Anonymize>) =>
      (await textPanels(fixture, 2)).map((element) => element.textContent);
    const title = (root: HTMLElement) =>
      root.querySelector('#anonymized-title')!.textContent!.trim();
    /** The processor answers in a microtask: let it settle before reading the view. */
    async function settle(fixture: ComponentFixture<Anonymize>): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await fixture.whenStable();
    }

    it('rewrites the anonymized text as a readable summary in the interface language', async () => {
      const { fixture, documents, root } = await results();
      const button = summarizeButton(root)!;
      expect(button.textContent).toContain('Summarize');
      expect(root.querySelector('.view-switch')).toBeNull();
      button.click();
      fixture.detectChanges();
      expect(summarizeButton(root)!.disabled).toBeTrue();
      expect(summarizeButton(root)!.textContent).toContain('Summarizing…');
      await settle(fixture);
      expect(summarizeButton(root)).toBeNull();
      const summary = documents.summary()!;
      expect(summary).toContain('Follow-up record');
      expect(title(root)).toBe('Readable summary');
      expect((await papers(fixture))[1]).toBe(summary);
      expect(root.querySelector('.protected-panel .paper-brand')!.textContent).toBe(
        'Written from the anonymized text only; the hidden data is not sent to create the summary.',
      );
      // The keyboard lands on the summary's switch, and the status says it is ready.
      expect(document.activeElement!.textContent!.trim()).toBe('Summary');
      expect(root.querySelector('.protected-panel [role="status"]')!.textContent!.trim()).toBe(
        'Summary ready',
      );
      const options = root.querySelectorAll<HTMLButtonElement>('.view-option');
      expect(Array.from(options, (option) => option.textContent!.trim())).toEqual([
        'Masked text',
        'Summary',
      ]);
      expect(options[1].getAttribute('aria-pressed')).toBe('true');
      options[0].click();
      await fixture.whenStable();
      expect((await papers(fixture))[1]).toBe(documents.result()!.anonymizedText);
      expect(title(root)).toBe('Anonymized');
      options[1].click();
      await fixture.whenStable();
      expect((await papers(fixture))[1]).toBe(summary);

      const createUrl = spyOn(URL, 'createObjectURL').and.returnValue('blob:summary');
      spyOn(URL, 'revokeObjectURL');
      let downloaded: { name: string; href: string } | undefined;
      spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(function (this: HTMLAnchorElement) {
        downloaded = { name: this.download, href: this.href };
      });
      const buttons = Array.from(
        root.querySelectorAll<HTMLButtonElement>('.page-action-group .btn'),
      );
      const downloadSummary = buttons.find((b) => b.textContent!.trim() === 'Download summary')!;
      expect(downloadSummary).toBeDefined();
      downloadSummary.click();
      expect(downloaded).toEqual({ name: 'ficha-summary.txt', href: 'blob:summary' });
      expect(await (createUrl.calls.mostRecent().args[0] as Blob).text()).toBe(summary);

      TestBed.inject(LanguageService).setPreference('pt-PT');
      await fixture.whenStable();
      expect(title(root)).toBe('Resumo legível');
      expect((await papers(fixture))[1]).toBe(summary);
      // The summary is in English now: it is offered again, beside the switch.
      expect(root.querySelector('.view-switch')).not.toBeNull();
      expect(summarizeButton(root)!.textContent).toContain('Resumir');
      summarizeButton(root)!.click();
      await settle(fixture);
      expect(documents.summary()).toContain('Ficha de acompanhamento');
      expect(summarizeButton(root)).toBeNull();

      root.querySelector<HTMLButtonElement>('.page-actions .btn-outline-secondary')!.click();
      await settle(fixture);
      expect(documents.summary()).toBeNull();
      await documents.anonymize();
      await settle(fixture);
      expect(summarizeButton(root)!.textContent).toContain('Resumir');
      expect((await papers(fixture))[1]).toBe(documents.result()!.anonymizedText);
    });

    it('downloads what the panel shows: the summary or the document', async () => {
      const { fixture, documents, root } = await results();
      summarizeButton(root)!.click();
      await settle(fixture);
      const primary = () => root.querySelector<HTMLButtonElement>('.page-actions .btn-primary')!;
      const fileName = () =>
        root.querySelector('.protected-panel .preview-file-name')!.textContent!.trim();
      const documentName = documents.result()!.download.name;
      expect(primary().textContent!.trim()).toBe('Download summary');
      expect(fileName()).toBe('ficha-summary.txt');

      spyOn(URL, 'createObjectURL').and.returnValue('blob:file');
      spyOn(URL, 'revokeObjectURL');
      const saved: string[] = [];
      spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(function (this: HTMLAnchorElement) {
        saved.push(this.download);
      });
      primary().click();
      Array.from(root.querySelectorAll<HTMLButtonElement>('.page-actions .btn-outline-secondary'))
        .find((button) => button.textContent!.trim() === 'Download document')!
        .click();
      expect(saved).toEqual(['ficha-summary.txt', documentName]);

      root.querySelectorAll<HTMLButtonElement>('.view-option')[0].click();
      await fixture.whenStable();
      expect(primary().textContent!.trim()).toBe('Download document');
      expect(fileName()).toBe(documentName);
      primary().click();
      expect(saved).toEqual(['ficha-summary.txt', documentName, documentName]);
    });

    it('shows an error when the summary fails and lets the user try again', async () => {
      let attempts = 0;
      TestBed.overrideProvider(DOCUMENT_PROCESSOR, {
        useValue: {
          ...exampleDocumentProcessor,
          summarize: async () => {
            if (++attempts === 1) throw new Error('Unavailable');
            return 'Resumo curto.';
          },
        },
      });
      const { fixture, root } = await results();
      summarizeButton(root)!.click();
      await settle(fixture);
      expect(root.querySelector('.summary-error')!.textContent).toBe(
        'The summary could not be generated. Please try again.',
      );
      expect(summarizeButton(root)!.disabled).toBeFalse();
      summarizeButton(root)!.click();
      await settle(fixture);
      expect(root.querySelector('.summary-error')).toBeNull();
      expect((await papers(fixture))[1]).toBe('Resumo curto.');
    });
  });
});
