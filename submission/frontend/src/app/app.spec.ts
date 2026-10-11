import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { DocumentService } from './document.service';
import {
  AnalyzedDocument,
  DOCUMENT_API_URL,
  DOCUMENT_PROCESSOR,
  ProcessedDocument,
} from './document-processor';
import { DocumentProgress } from './document-progress';
import { App } from './app';
import { ThemeService } from './theme.service';
import { LanguageService } from './language.service';

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;

describe('Application shell and preferences', () => {
  let savedTheme: string | null;
  let savedLanguage: string | null;

  beforeEach(() => {
    savedTheme = localStorage.getItem('theme');
    savedLanguage = localStorage.getItem('language');
    localStorage.removeItem('theme');
    localStorage.removeItem('language');
    TestBed.configureTestingModule({ imports: [App], providers: [provideRouter(routes)] });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    for (const [key, value] of [
      ['theme', savedTheme],
      ['language', savedLanguage],
    ]) {
      if (value === null) localStorage.removeItem(key!);
      else localStorage.setItem(key!, value!);
    }
    document.documentElement.removeAttribute('data-bs-theme');
    document.documentElement.lang = 'en';
  });

  it('defaults to light and switches between light and dark', () => {
    const theme = TestBed.inject(ThemeService);
    expect(theme.preference()).toBe('light');
    expect(document.documentElement.getAttribute('data-bs-theme')).toBe('light');
    theme.setPreference('dark');
    expect(document.documentElement.getAttribute('data-bs-theme')).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
    theme.setPreference('light');
    expect(document.documentElement.getAttribute('data-bs-theme')).toBe('light');
  });

  it('restores persisted preferences on initialization', () => {
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('language', 'pt-PT');
    expect(TestBed.inject(ThemeService).preference()).toBe('dark');
    expect(TestBed.inject(LanguageService).preference()).toBe('pt-PT');
    expect(document.documentElement.lang).toBe('pt-PT');
  });

  it('falls back to defaults for invalid saved values', () => {
    localStorage.setItem('theme', 'invalid');
    localStorage.setItem('language', 'invalid');
    expect(TestBed.inject(ThemeService).preference()).toBe('light');
    expect(TestBed.inject(LanguageService).preference()).toBe('en');
  });

  it('works when localStorage is unavailable', () => {
    spyOn(Storage.prototype, 'getItem').and.throwError('Unavailable');
    spyOn(Storage.prototype, 'setItem').and.throwError('Unavailable');
    const theme = TestBed.inject(ThemeService);
    const language = TestBed.inject(LanguageService);
    expect(() => {
      theme.setPreference('dark');
      language.setPreference('pt-PT');
    }).not.toThrow();
    expect(document.documentElement.lang).toBe('pt-PT');
  });

  it('switches rendered text immediately and persists language', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const appearanceLabel = () =>
      fixture.nativeElement.querySelector('.theme-toggle').getAttribute('aria-label');
    expect(appearanceLabel()).toBe('Appearance');
    TestBed.inject(LanguageService).setPreference('pt-PT');
    await fixture.whenStable();
    expect(appearanceLabel()).toBe('Aparência');
    expect(document.documentElement.lang).toBe('pt-PT');
    expect(document.title).toBe('DataVeil');
    expect(localStorage.getItem('language')).toBe('pt-PT');
    TestBed.inject(LanguageService).setPreference('en');
    await fixture.whenStable();
    expect(appearanceLabel()).toBe('Appearance');
  });

  it('describes local file handling in the footer while the API endpoint is unset', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const note = () =>
      fixture.nativeElement.querySelector('.site-footer p:last-child').textContent.trim();
    expect(note()).toBe('Your files are never sent to a server.');
    TestBed.inject(LanguageService).setPreference('pt-PT');
    await fixture.whenStable();
    expect(note()).toBe('Os seus ficheiros não são enviados para nenhum servidor.');
  });

  it('describes API processing truthfully in both footer languages without sending an unselected file', async () => {
    TestBed.overrideProvider(DOCUMENT_API_URL, { useValue: '/api/documents/anonymize' });
    const fetchRequest = spyOn(window, 'fetch');
    const fixture = TestBed.createComponent(App);
    await TestBed.inject(Router).navigateByUrl('/');
    await fixture.whenStable();
    const note = () =>
      fixture.nativeElement.querySelector('.site-footer p:last-child').textContent.trim();
    expect(note()).toBe('Documents are sent for analysis and anonymization.');
    TestBed.inject(LanguageService).setPreference('pt-PT');
    await fixture.whenStable();
    expect(note()).toBe('O documento é enviado para análise e anonimização.');
    expect(TestBed.inject(DocumentService).file()).toBeNull();
    expect(fixture.nativeElement.querySelector('.upload-actions button').disabled).toBeTrue();
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it('changes theme from the top bar toggle and persists the selected mode', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const toggle = root.querySelector<HTMLButtonElement>('.theme-toggle')!;
    expect(TestBed.inject(ThemeService).preference()).toBe('light');
    for (const mode of ['dark', 'light'] as const) {
      toggle.click();
      await fixture.whenStable();
      expect(TestBed.inject(ThemeService).preference()).toBe(mode);
      expect(localStorage.getItem('theme')).toBe(mode);
      expect(document.documentElement.getAttribute('data-bs-theme')).toBe(mode);
    }
  });

  it('changes language from the top bar menu and persists the choice', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const toggle = root.querySelector<HTMLButtonElement>('.language-select')!;
    expect(root.querySelector('.language-menu')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    await fixture.whenStable();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const options = root.querySelectorAll<HTMLButtonElement>('.language-option');
    expect(Array.from(options, (option) => option.textContent!.trim())).toEqual([
      'English',
      'Português (Portugal)',
    ]);
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    options[1].click();
    await fixture.whenStable();
    expect(document.documentElement.lang).toBe('pt-PT');
    expect(localStorage.getItem('language')).toBe('pt-PT');
    expect(root.querySelector('.language-menu')).toBeNull();
    expect(toggle.textContent).toContain('Português (Portugal)');
    expect(toggle.querySelector('img')!.getAttribute('src')).toBe('flags/pt.svg');
    toggle.click();
    await fixture.whenStable();
    root.querySelectorAll<HTMLButtonElement>('.language-option')[0].click();
    await fixture.whenStable();
    expect(document.documentElement.lang).toBe('en');
    expect(toggle.textContent).toContain('English');
    // A click elsewhere closes the menu.
    toggle.click();
    await fixture.whenStable();
    expect(root.querySelector('.language-menu')).not.toBeNull();
    root
      .querySelector<HTMLElement>('main')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await fixture.whenStable();
    expect(root.querySelector('.language-menu')).toBeNull();
  });

  it('gives the top bar preferences accessible names', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('header .theme-toggle')!.getAttribute('aria-label')).toBe(
      'Appearance',
    );
    expect(root.querySelector('header .language-select')!.getAttribute('aria-label')).toBe(
      'Language',
    );
  });

  it('uses one workflow route with a brand and global preferences', async () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    for (const url of ['/', '/anonymize', '/results', '/unknown']) {
      await router.navigateByUrl(url);
      await fixture.whenStable();
      expect(router.url).toBe('/');
      expect(fixture.nativeElement.querySelector('.upload-section')).not.toBeNull();
      expect(fixture.nativeElement.querySelectorAll('header nav a').length).toBe(1);
      expect(fixture.nativeElement.querySelector('.brand').getAttribute('href')).toBe('/');
      expect(fixture.nativeElement.querySelector('header .theme-toggle')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('header .language-select')).not.toBeNull();
    }
  });

  it('updates document progress across selection, analysis, results and reset', async () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    const documents = TestBed.inject(DocumentService);
    await router.navigateByUrl('/');
    await fixture.whenStable();
    const selectPdf = async (name: string) => {
      const input = fixture.nativeElement.querySelector('input[type="file"]') as HTMLInputElement;
      const data = new DataTransfer();
      data.items.add(new File(['%PDF-local'], name, { type: 'application/pdf' }));
      input.files = data.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await fixture.whenStable();
    };
    const current = () =>
      fixture.nativeElement.querySelector(
        '.document-progress [aria-current="step"]',
      ) as HTMLElement;
    const completed = () =>
      fixture.nativeElement.querySelectorAll('.document-progress .complete').length;
    // No step is current until a document is chosen.
    expect(current()).toBeNull();
    expect(completed()).toBe(0);
    await documents.analyze();
    await fixture.whenStable();
    expect(current()).toBeNull();
    await selectPdf('sample.pdf');
    expect(current().textContent).toContain('Document');
    expect(completed()).toBe(0);
    fixture.nativeElement.querySelector('.upload-actions button').click();
    await fixture.whenStable();
    expect(document.activeElement?.id).toBe('analysis-title');
    expect(fixture.nativeElement.querySelectorAll('main h1').length).toBe(1);
    expect(current().textContent).toContain('Analysis');
    expect(completed()).toBe(1);
    fixture.nativeElement.querySelector('.page-actions .btn-primary').click();
    await new Promise((resolve) => setTimeout(resolve, 5100));
    await fixture.whenStable();
    expect(document.activeElement?.id).toBe('results-title');
    expect(fixture.nativeElement.querySelectorAll('main h1').length).toBe(1);
    expect(router.url).toBe('/');
    expect(fixture.nativeElement.querySelector('app-results')).not.toBeNull();
    expect(current().textContent).toContain('Results');
    expect(completed()).toBe(3);
    TestBed.inject(LanguageService).setPreference('pt-PT');
    await fixture.whenStable();
    expect(current().textContent).toContain('Resultados');
    expect(
      fixture.nativeElement.querySelector('.document-progress').getAttribute('aria-label'),
    ).toBe('Progresso do documento');
    fixture.nativeElement.querySelector('.page-actions .btn-outline-secondary').click();
    await fixture.whenStable();
    expect(document.activeElement?.id).toBe('analysis-title');
    expect(fixture.nativeElement.querySelectorAll('main h1').length).toBe(1);
    expect(router.url).toBe('/');
    expect(documents.file()).not.toBeNull();
    expect(documents.result()).toBeNull();
    expect(current().textContent).toContain('Análise');
    expect(completed()).toBe(1);
    fixture.nativeElement.querySelector('.page-actions .btn-outline-secondary').click();
    await fixture.whenStable();
    expect(document.activeElement?.id).toBe('intro-title');
    expect(current().textContent).toContain('Documento');
    expect(completed()).toBe(0);
    fixture.nativeElement.querySelector('.selected-file button').click();
    await fixture.whenStable();
    expect(current()).toBeNull();
    expect(completed()).toBe(0);
  });

  it('shows each processing step only when its operation starts', async () => {
    let resolveAnalysis!: (analysis: AnalyzedDocument) => void;
    let resolveAnonymization!: (result: ProcessedDocument) => void;
    TestBed.overrideProvider(DOCUMENT_PROCESSOR, {
      useValue: {
        analyze: () => new Promise<AnalyzedDocument>((resolve) => (resolveAnalysis = resolve)),
        anonymize: () =>
          new Promise<ProcessedDocument>((resolve) => (resolveAnonymization = resolve)),
      },
    });
    const fixture = TestBed.createComponent(DocumentProgress);
    const documents = TestBed.inject(DocumentService);
    const current = () =>
      fixture.nativeElement.querySelector('[aria-current="step"]').textContent.trim();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('li').length).toBe(4);
    expect(fixture.nativeElement.querySelector('[aria-current="step"]')).toBeNull();
    documents.select(new File(['%PDF-local'], 'sample.pdf', { type: 'application/pdf' }));
    fixture.detectChanges();
    expect(current()).toContain('Document');
    const pendingAnalysis = documents.analyze();
    fixture.detectChanges();
    expect(current()).toContain('Analysis');
    const analysis: AnalyzedDocument = {
      id: 'analysis-1',
      originalText: 'Ana',
      entities: [{ id: 'name-1', start: 0, end: 3, type: 'NAME', replacement: '[NAME]' }],
      source: 'example',
    };
    resolveAnalysis(analysis);
    await pendingAnalysis;
    fixture.detectChanges();
    expect(current()).toContain('Analysis');
    const pendingAnonymization = documents.anonymize();
    fixture.detectChanges();
    expect(current()).toContain('Anonymization');
    expect(fixture.nativeElement.querySelectorAll('.complete').length).toBe(2);
    expect(fixture.nativeElement.querySelectorAll('.complete svg').length).toBe(2);
    resolveAnonymization({
      originalText: analysis.originalText,
      anonymizedText: '[NAME]',
      entities: analysis.entities,
      download: {
        name: 'sample.txt',
        blob: new Blob(['[NAME]'], { type: 'text/plain' }),
      },
      source: 'example',
    });
    await pendingAnonymization;
    fixture.detectChanges();
    expect(current()).toContain('Results');
    expect(fixture.nativeElement.querySelectorAll('.complete').length).toBe(3);
  });

  it('shows the comparison through the analysis action and resets on the same page', async () => {
    const fixture = TestBed.createComponent(App);
    const documents = TestBed.inject(DocumentService);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-results')).toBeNull();
    documents.select(new File(['%PDF-demo'], 'example.pdf', { type: 'application/pdf' }));
    await fixture.whenStable();
    fixture.nativeElement.querySelector('.upload-actions button').click();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-results')).toBeNull();
    fixture.nativeElement.querySelector('.page-actions .btn-primary').click();
    await new Promise((resolve) => setTimeout(resolve, 5100));
    await fixture.whenStable();
    expect(router.url).toBe('/');
    // The file is not a real PDF: both panels fall back to the text once rendering fails.
    const panels = (): HTMLElement[] =>
      Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
          '.paper .document-text',
        ),
      );
    for (let i = 0; i < 100 && panels().length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fixture.whenStable();
    }
    expect(panels()[0].textContent).toBe(documents.result()!.originalText);
    expect(panels()[1].textContent).toBe(documents.result()!.anonymizedText);
    fixture.nativeElement.querySelector('.page-actions .btn-outline-secondary').click();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-results')).toBeNull();
    expect(fixture.nativeElement.querySelector('.analysis-grid')).not.toBeNull();
    fixture.nativeElement.querySelector('.page-actions .btn-outline-secondary').click();
    await fixture.whenStable();
    expect(router.url).toBe('/');
    expect(fixture.nativeElement.querySelector('.upload-section')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.upload-actions button').disabled).toBeFalse();
    fixture.nativeElement.querySelector('.selected-file button').click();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.upload-actions button').disabled).toBeTrue();
    expect(documents.file()).toBeNull();
    expect(documents.result()).toBeNull();
  });
});
