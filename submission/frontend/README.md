# DataVeil frontend

Angular frontend for the NOS JunctionX Lisbon 2026 document anonymization project. The frontend is prepared for the future document processing API; backend implementation remains separate.

## Stack and commands

Angular 21, strict TypeScript, standalone OnPush components, Signals, Angular Router, CSS, Bootstrap 5, locally bundled Font Awesome icons, and PDF.js for local first-page thumbnails. Jasmine/Karma run tests in Chrome. No SSR, SSG, or additional HTTP, UI, state, or internationalization libraries. Font Awesome uses individual SVG definitions from the free solid icon set, rendered with Angular attribute bindings; no CDN or icon kit requests.

Use Node.js 22.13+ (22 LTS) and npm. From `submission/frontend/`:

```sh
npm ci
npm start
npm run build
npm test -- --watch=false --browsers=ChromeHeadless
```

The development server is http://localhost:4200. `npm test` runs in watch mode. Chrome must be installed for browser tests; set `CHROME_BIN` if necessary. Production files are generated in `dist/dataveil/browser/`. A production static host must route unknown paths to `index.html` for SPA navigation.

## Page and structure

The application has one page at `/`. A short introduction appears above single-PDF selection, followed by analysis, a choice of data to anonymize, and a side-by-side comparison with a document download. Each action updates the same page without changing the URL. Selecting another document resets the workflow. Old `/anonymize` and `/results` URLs, along with unknown paths, redirect to `/`.

Workflow components are under `src/app/pages/`; `Results` is embedded in `Anonymize`. The root component contains the top bar and footer. Small services manage preferences and document state; translations are centralized in `language.service.ts`. The progress indicator displays Document → Analysis → Anonymization → Results. Selecting a file stays on Document. Starting analysis advances to Analysis, where users review the detected data. Confirming their selection starts Anonymization; only a successful response advances to Results. Clearing or replacing the document resets progress. No simulated percentages or timers are used.

The shell uses the available viewport height without changing browser zoom. Navigation, actions, and the footer remain visible throughout. The introduction, progress, and selection panel are centered as one group. Selection keeps the same panel height before and after choosing a file, shrinking on smaller viewports. The selected document appears beside the picker, including on mobile, with its format label, first-page thumbnail, filename, size, and accessible remove button. Documents and entities scroll in named, keyboard-focusable regions when necessary. Narrow screens stack review and comparison panels inside one scrollable workspace.

`pdf-preview` loads [PDF.js](https://mozilla.github.io/pdf.js/examples/) only after selection and renders the first page locally to a small canvas. Its worker is served from the application's own assets. Rendering is cancelled and cleaned up on replacement/removal. Invalid or password-protected documents show an unavailable-preview message without blocking analysis.

All occurrences are selected initially. Native checkboxes allow selecting everything, whole categories, or individual occurrences; mixed groups show an indeterminate state. Identical values at different offsets remain independent. Category labels and Font Awesome icons are defined in `document-categories.ts`; theme-specific colors are in `styles.css`. Supported API categories are NAME, ID, CONTACT, DOB, FINANCIAL, HEALTH, SPECIAL, PRIVATE_LIFE, AGE, OCCUPATION, CLINICIAN, and SEX. Classification and contextual precedence belong to the backend. Only categories returned by the API appear; unknown categories remain selectable with a fallback label/icon.

Data the analysis missed can be marked by hand on the review screen. Selecting text in the document preview snaps the selection to whole words, which are exactly the words the backend masks, and opens a small form under it to choose a category or name a new one. When the same words appear elsewhere as whole words, the form offers to mark those occurrences too; text that overlaps identified data cannot be marked again. Marked occurrences join the list with an "Added by you" badge and a remove button, and are selected, highlighted and anonymized like detected ones. The browser keeps the marks of the last document analysed in localStorage: their offsets, category and whether they are selected, under a hash of the file name, size and text, never the text itself. Analysing the same file again, after going back or reloading the page, restores them and offers their new categories again; analysing another document replaces them. The helpers are in `manual-selection.ts`, the storage in `manual-storage.ts` and the form in `manual-entity-form.ts`.

## Preferences and accessibility

Appearance defaults to System, follows live OS changes, and supports explicit Light and Dark modes. Bootstrap's `data-bs-theme` and application CSS variables control the palette. English is the default language; Portuguese (Portugal) applies immediately and updates HTML `lang`. These preferences, and the positions of text marked by hand, are stored in localStorage.

The top bar offers side-by-side language flags and a compact native dropdown for Light, Dark, and System appearance. The selected language has a visible border, and each flag has an accessible language name and tooltip. The UK/Portugal flags are original, unmodified SVGs from [flag-icons v7.3.2](https://github.com/lipis/flag-icons/tree/fe15c16e7463d0c66d6c5730e9d0e832438d98e1/flags/4x3), served locally without a package or CDN. Source details and the upstream MIT license are included in `public/flags/`. Native radio inputs and the select provide keyboard navigation without a separate settings panel or custom dropdown logic. A skip link and visible focus styles support keyboard use. Workflow transitions focus the new heading after render. Spacing is compact across the introduction, upload panel, buttons, and document viewers; layouts adapt to mobile, tablet, and desktop.

## Processing and API integration

The two-stage contract is documented in [API_CONTRACT.md](API_CONTRACT.md). `POST /api/documents/analyze` receives multipart field `file` and returns an analysis ID, original text, and entity occurrences with unique IDs and UTF-16 ranges. After review, `POST /api/documents/{analysisId}/anonymize` receives `selectedEntityIds`, plus `manualEntities` ranges for text marked by hand, and returns anonymized text plus the matching file as base64 with its filename and MIME type. `document-api.ts` implements both requests using native browser APIs. The frontend never uses a fully anonymized artifact for a partial selection.

Set `DOCUMENT_API_URL` in `src/app/app.config.ts` to the backend base URL, such as `/api/documents`, when available. It defaults to `null`: analysis then uses a fixed local example, while the separate thumbnail reads the selected PDF locally. Text marked by hand is then masked locally, each word becoming `*` with its punctuation kept, as the backend does. No selected file is uploaded in this mode. No proxy or backend endpoint is implemented. The footer reflects the configured processing mode.

On the results page, "Summarize" asks the backend for a readable rewrite of the anonymized document, in the interface language, for the same selection that produced the result. Only the masked text leaves the browser's result; the hidden values are never part of the request. The summary replaces the masked text in the "Anonymized" panel, with a switch back to the masked text, and can be downloaded as a `.txt`. Changing the selection or the document discards it. The local example returns a fixed summary.

The same asynchronous processor contract drives both modes. Each operation prevents duplicate requests, supports cancellation and retry, and ignores obsolete responses after a reset or new selection. Anonymization failures retain the review and choices. Text, entities, explanations, and downloadable bytes come from the processor. Empty entity lists and explicit empty selections are supported. Text is rendered safely with preserved whitespace; changing language does not change document content or selections. Downloads use the returned Blob and filename, allowing TXT or PDF output without rebuilding backend output in the frontend.

PDF eligibility checks filename/MIME and nonzero size; the backend must perform content validation. The default example remains fictional and labeled, with a static Portuguese document and `dataveil-example.txt`. Files/results stay in memory and disappear on refresh. Only theme, language and the positions of text marked by hand in the last document analysed are saved in localStorage. No document text, selected document or processing result is persisted.

Backend processing, authentication, NLP, and AI functionality are not implemented in the frontend. Styling uses the original navy/purple palette and restrained borders. The background is a nearly flat vertical CSS gradient with a slight tonal variation for each theme. The header, footer, and panels keep solid backgrounds. The local mockups inform the palette, numbered horizontal steps, upload panel with a format label, and document previews with compact toolbars. Preview sheets stay white with dark text in both themes. The initial screen places a brief introduction directly above the compact PDF selection form; the compact top bar and shared footer remain visible throughout. The footer credits Duarte, Guilherme, João and Joel, displays © 2026, and shows the privacy text appropriate to the configured processing mode. Actions and headings use normal product wording in both languages. Preview sheets from the local processor are labeled as example documents. Live document processing requires an available backend implementing the documented contract.

The requested Karma dependency chain currently reports six high-severity npm audit findings through `braces`/`chokidar`; npm's suggested automatic fixes would downgrade the required tooling. No forced downgrade has been applied.
