import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  Injector,
  inject,
  Renderer2,
  signal,
  viewChild,
} from '@angular/core';
import {
  faArrowLeft,
  faArrowRight,
  faFileArrowUp,
  faShieldHalved,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { DocumentService, MIN_ANONYMIZATION_DURATION } from '../../document.service';
import { LanguageService } from '../../language.service';
import { DocumentProgress } from '../../document-progress';
import { Results } from '../results/results';
import { PdfPreview } from '../../pdf-preview';
import { EntitySelection } from '../../entity-selection';
import { categoryDetails, categoryLabel } from '../../document-categories';
import { AnalyzedDocument } from '../../document-processor';
import { ManualEntityChoice, ManualEntityForm } from '../../manual-entity-form';
import {
  TextRange,
  findOtherOccurrences,
  overlaps,
  selectionRange,
  snapToWords,
  textRange,
} from '../../manual-selection';

/** Text selected in the preview, waiting for a category. */
interface PendingSelection extends TextRange {
  /** Different for every selection, so that each one gets a new form. */
  readonly key: number;
  /** The offsets belong to this analysis only; any other one makes the selection obsolete. */
  readonly analysis: AnalyzedDocument;
  readonly text: string;
  /** Overlaps identified data: the form only explains why it cannot be marked. */
  readonly overlap: boolean;
  /** IDs of the identified occurrences it overlaps. */
  readonly overlapped: readonly string[];
  /** Other whole-word occurrences that can be marked at the same time. */
  readonly occurrences: readonly TextRange[];
}

type Segment = ReturnType<DocumentService['originalSegments']>[number] & {
  readonly pending?: boolean;
};

/** Touch selections are adjusted with handles, so they are read once they stop changing. */
const TOUCH_SELECTION_DELAY = 500;
const FORM_WIDTH = 300;
const FORM_MARGIN = 8;

@Component({
  selector: 'app-anonymize',
  imports: [DocumentProgress, Results, PdfPreview, EntitySelection, ManualEntityForm],
  templateUrl: './anonymize.html',
  styleUrl: './anonymize.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Anonymize {
  protected readonly language = inject(LanguageService);
  protected readonly documents = inject(DocumentService);
  protected readonly fileFormat = computed(
    () => this.documents.file()?.name.split('.').pop()?.toUpperCase() ?? '',
  );
  protected readonly removeIcon = faXmark;
  protected readonly uploadIcon = faFileArrowUp;
  protected readonly nextIcon = faArrowRight;
  protected readonly anonymizationIcon = faShieldHalved;
  protected readonly backIcon = faArrowLeft;
  protected readonly categoryDetails = categoryDetails;
  protected readonly dragging = signal(false);
  protected readonly error = signal<'fileError' | 'emptyPdf' | null>(null);
  protected readonly pending = signal<PendingSelection | null>(null);
  /**
   * False once a press or focus goes elsewhere. The form and the highlight are then hidden, not
   * removed: removing the form could shrink the scrolled preview and move the text under the
   * pointer in the middle of a double-click or drag. A new selection replaces them.
   */
  protected readonly formOpen = signal(false);
  protected readonly formPosition = signal({ top: 0, left: 0 });
  protected readonly lastCategory = signal('NAME');
  protected readonly announcement = signal('');
  /** The pending selection while it still belongs to the analysis under review. */
  protected readonly selection = computed(() => {
    const pending = this.pending();
    return pending && pending.analysis === this.documents.analysis() && !this.documents.processing()
      ? pending
      : null;
  });
  /** At most one form, tracked by the selection key, hidden while formOpen() is false. */
  protected readonly forms = computed(() => {
    const selection = this.selection();
    return selection ? [selection] : [];
  });
  /** Review segments: the plain segment holding the pending selection is split to highlight it. */
  protected readonly segments = computed<readonly Segment[]>(() => {
    const segments = this.documents.originalSegments();
    const selection = this.selection();
    return selection && !selection.overlap ? highlightPending(segments, selection) : segments;
  });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly previewRegion = viewChild<ElementRef<HTMLElement>>('previewRegion');
  private readonly paper = viewChild<ElementRef<HTMLElement>>('paper');
  private readonly documentText = viewChild<ElementRef<HTMLElement>>('documentText');
  private readonly form = viewChild(ManualEntityForm, { read: ElementRef });
  private pointerHeld = false;
  private pressOutsideForm = false;
  private touch = false;
  private touchTimer?: ReturnType<typeof setTimeout>;
  private selections = 0;

  constructor() {
    // Document-wide listeners outside the template, so that these frequent events do not run
    // change detection by themselves; only the signals they change do.
    const renderer = inject(Renderer2);
    const listeners = [
      renderer.listen('document', 'pointerdown', (event: PointerEvent) => this.pointerDown(event)),
      renderer.listen('document', 'pointerup', (event: PointerEvent) => this.pointerUp(event)),
      renderer.listen('document', 'pointercancel', () => this.pointerCancel()),
      renderer.listen('document', 'selectionchange', () => {
        if (this.touch) this.scheduleTouchSelection();
      }),
      renderer.listen('window', 'resize', () => this.placeForm()),
    ];
    inject(DestroyRef).onDestroy(() => {
      for (const unlisten of listeners) unlisten();
      clearTimeout(this.touchTimer);
    });
    effect(() => {
      if (this.documents.processing()) this.closeForm(false);
    });
  }

  protected choose(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.length) this.select(Array.from(input.files));
    input.value = '';
  }

  protected dragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(!this.documents.processing());
  }
  protected drop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    this.select(Array.from(event.dataTransfer?.files ?? []));
  }
  protected remove(): void {
    this.documents.clear();
    this.error.set(null);
    this.focusHeading();
  }

  protected async startAnalysis(): Promise<void> {
    if (await this.documents.analyze()) this.focusHeading();
  }

  protected async anonymizeSelected(): Promise<void> {
    this.closeForm(false);
    if (await this.documents.anonymize(MIN_ANONYMIZATION_DURATION)) this.focusHeading();
  }

  protected backToDocument(): void {
    this.documents.returnToDocument();
    this.focusHeading();
  }

  protected backToReview(): void {
    this.documents.returnToReview();
    this.focusHeading();
  }

  /**
   * Mouse and pen selections are complete on release, also outside the text (document listener).
   * Also bound on the text itself; handling the same release twice is harmless.
   */
  protected pointerUp(event: PointerEvent): void {
    this.pointerHeld = false;
    if (event.pointerType === 'touch') {
      // A tap outside the form dismisses it, unless it selected text (read after the delay).
      if (this.pressOutsideForm) this.formOpen.set(false);
      this.scheduleTouchSelection();
    } else {
      this.captureSelection();
    }
    this.pressOutsideForm = false;
  }

  /**
   * Keyboard selections (caret browsing) are complete once Shift is released. Shortcuts such as
   * Ctrl+A or Ctrl+C are not selections to mark.
   */
  protected keyUp(event: KeyboardEvent): void {
    const target = event.target instanceof Node ? event.target : null;
    if (
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      ['Control', 'Meta', 'Alt'].includes(event.key) ||
      (target && this.form()?.nativeElement.contains(target))
    )
      return;
    this.captureSelection();
  }

  /** Focus leaving the form for something other than the preview hides it, as a press would. */
  protected formFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    const form = this.form()?.nativeElement;
    if (!next || !form || form.contains(next) || next === this.previewRegion()?.nativeElement)
      return;
    this.formOpen.set(false);
  }

  /** The selection overlaps occurrences that are listed but not selected: select them instead. */
  protected selectExisting(): void {
    const selection = this.selection();
    if (!selection) return;
    this.documents.setEntities(selection.overlapped, true);
    this.closeForm(true);
  }

  protected addManual(choice: ManualEntityChoice): void {
    const selection = this.selection();
    if (!selection) return;
    const ranges = [selection, ...(choice.others ? selection.occurrences : [])];
    if (!this.documents.addManualEntities(ranges, choice.type).length) return;
    this.lastCategory.set(choice.type);
    const text = this.language.text();
    const label = categoryLabel(choice.type, text);
    // A replacer function, so that "$&" or "$$" in a category name stay as typed.
    this.announcement.set(text.manualAdded.replace('{category}', () => label));
    this.closeForm(true);
  }

  protected closeForm(restoreFocus: boolean): void {
    this.pending.set(null);
    this.formOpen.set(false);
    if (restoreFocus) this.previewRegion()?.nativeElement.focus({ preventScroll: true });
  }

  private pointerDown(event: PointerEvent): void {
    this.pointerHeld = true;
    this.touch = event.pointerType === 'touch';
    const target = event.target instanceof Node ? event.target : null;
    this.pressOutsideForm =
      this.formOpen() && !(target && this.form()?.nativeElement.contains(target));
    // Mouse and pen: hide the form at once, without removing it, so that nothing moves under the
    // pointer while a new selection may start. Touch waits for the release, since the press may
    // turn into a scroll.
    if (this.pressOutsideForm && !this.touch) this.formOpen.set(false);
  }

  /** The press became a scroll (touch) or the browser took it over: the form stays as it was. */
  private pointerCancel(): void {
    this.pointerHeld = false;
    this.pressOutsideForm = false;
    this.scheduleTouchSelection();
  }

  private scheduleTouchSelection(): void {
    clearTimeout(this.touchTimer);
    this.touchTimer = setTimeout(() => {
      if (!this.pointerHeld) this.captureSelection();
    }, TOUCH_SELECTION_DELAY);
  }

  /** Opens the form for the text selected in the preview, snapped to whole words. */
  private captureSelection(): void {
    const analysis = this.documents.analysis();
    const container = this.documentText()?.nativeElement;
    const selected = this.document.getSelection();
    const offsets =
      analysis && container && selected?.rangeCount && !selected.isCollapsed
        ? selectionRange(container, selected.getRangeAt(0))
        : null;
    const range =
      analysis && offsets && !this.documents.processing()
        ? snapToWords(analysis.originalText, offsets.start, offsets.end)
        : null;
    // Nothing selected: a form hidden by the press stays hidden until another selection.
    if (!analysis || !range) return;
    const overlapped = analysis.entities
      .filter((entity) => overlaps(entity, [range]))
      .map((entity) => entity.id);
    const overlap = overlapped.length > 0;
    const { start, end } = range;
    selected?.removeAllRanges();
    this.announcement.set('');
    this.pending.set({
      key: ++this.selections,
      analysis,
      start,
      end,
      text: analysis.originalText.slice(start, end),
      overlap,
      overlapped,
      occurrences: overlap
        ? []
        : findOtherOccurrences(analysis.originalText, start, end, analysis.entities),
    });
    this.formOpen.set(true);
    this.placeForm();
  }

  /** Just below the selected text, horizontally inside the paper. */
  private placeForm(): void {
    const selection = this.selection();
    const paper = this.paper()?.nativeElement;
    const container = this.documentText()?.nativeElement;
    if (!selection || !this.formOpen() || !paper || !container) return;
    const box = paper.getBoundingClientRect();
    const rect = (
      textRange(container, selection.start, selection.end) ?? container
    ).getBoundingClientRect();
    const width = Math.min(FORM_WIDTH, paper.clientWidth - 2 * FORM_MARGIN);
    const left = rect.left - box.left - paper.clientLeft;
    this.formPosition.set({
      top: Math.round(rect.bottom - box.top - paper.clientTop + 6),
      left: Math.round(
        Math.max(FORM_MARGIN, Math.min(left, paper.clientWidth - width - FORM_MARGIN)),
      ),
    });
  }

  private focusHeading(): void {
    afterNextRender(
      () =>
        this.host.nativeElement.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true }),
      { injector: this.injector },
    );
  }

  private select(files: File[]): void {
    if (this.documents.processing()) return;
    const file = files[0];
    if (
      files.length !== 1 ||
      !file ||
      !/\.pdf$/i.test(file.name) ||
      (file.type !== '' && file.type !== 'application/pdf')
    ) {
      this.error.set('fileError');
      return;
    }
    if (!file.size) {
      this.error.set('emptyPdf');
      return;
    }
    this.error.set(null);
    this.documents.select(file);
  }
}

/** Splits the plain segment that contains the range, so that the range can be highlighted. */
function highlightPending(segments: readonly Segment[], range: TextRange): Segment[] {
  const result: Segment[] = [];
  let start = 0;
  for (const segment of segments) {
    const end = start + segment.text.length;
    if (segment.sensitive || range.start < start || range.end > end) {
      result.push(segment);
    } else {
      const before = segment.text.slice(0, range.start - start);
      const after = segment.text.slice(range.end - start);
      if (before) result.push({ text: before, sensitive: false });
      result.push({
        text: segment.text.slice(range.start - start, range.end - start),
        sensitive: false,
        pending: true,
      });
      if (after) result.push({ text: after, sensitive: false });
    }
    start = end;
  }
  return result;
}
