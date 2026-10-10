import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  Injector,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  CATEGORY_DETAILS,
  MAX_CATEGORY_LABEL_LENGTH,
  customCategoryCode,
  normalizeCategoryLabel,
} from './document-categories';
import { DocumentService } from './document.service';
import { LanguageService } from './language.service';

/** Value of the option that asks for the name of a new category; no category code has it. */
const NEW_CATEGORY = 'new';
let nextId = 0;

export interface ManualEntityChoice {
  /** Taxonomy code or user-defined `custom:` category. */
  readonly type: string;
  /** Whether the other occurrences of the same text are marked too. */
  readonly others: boolean;
}

/** Non-modal form that gives a category to the text selected in the document preview. */
@Component({
  selector: 'app-manual-entity-form',
  templateUrl: './manual-entity-form.html',
  styleUrl: './manual-entity-form.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ManualEntityForm {
  /** The selected text, quoted in the form. */
  readonly text = input.required<string>();
  /** The selection overlaps identified data: only an explanation is shown. */
  readonly overlap = input(false);
  /** The overlapped data is listed but not selected: offer to select it instead. */
  readonly deselected = input(false);
  /** Number of other whole-word occurrences that can be marked at the same time. */
  readonly occurrences = input(0);
  readonly defaultCategory = input('NAME');
  readonly added = output<ManualEntityChoice>();
  readonly selectExisting = output<void>();
  readonly closed = output<void>();

  protected readonly language = inject(LanguageService);
  protected readonly documents = inject(DocumentService);
  protected readonly id = `manual-entity-${++nextId}`;
  protected readonly newCategory = NEW_CATEGORY;
  protected readonly maxLength = MAX_CATEGORY_LABEL_LENGTH;
  protected readonly customCategoryCode = customCategoryCode;
  protected readonly builtInCategories = Object.entries(CATEGORY_DETAILS).map(
    ([code, details]) => ({ code, labelKey: details.labelKey }),
  );
  protected readonly category = linkedSignal(() => {
    const code = this.defaultCategory();
    const known =
      Object.prototype.hasOwnProperty.call(CATEGORY_DETAILS, code) ||
      this.documents.customCategories().some((label) => customCategoryCode(label) === code);
    return known ? code : 'NAME';
  });
  protected readonly name = signal('');
  protected readonly others = signal(true);
  protected readonly valid = computed(
    () => this.category() !== NEW_CATEGORY || !!normalizeCategoryLabel(this.name()),
  );
  protected readonly overlapMessage = computed(() =>
    this.deselected() ? this.language.text().manualDeselected : this.language.text().manualOverlap,
  );
  protected readonly othersLabel = computed(() => {
    const text = this.language.text();
    const count = this.occurrences();
    return count === 1
      ? text.markOtherOccurrence
      : text.markOtherOccurrences.replace('{count}', String(count));
  });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly select = viewChild<ElementRef<HTMLSelectElement>>('categorySelect');
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('closeButton');
  private readonly actionButton = viewChild<ElementRef<HTMLButtonElement>>('actionButton');
  /** The last choice in the select came from the pointer, not from arrow keys or End. */
  private pointerChoice = false;

  constructor() {
    afterNextRender(() => {
      this.host.nativeElement.scrollIntoView({ block: 'nearest' });
      (this.select() ?? this.actionButton() ?? this.closeButton())?.nativeElement.focus({
        preventScroll: true,
      });
    });
  }

  /** A method, not an assignment: a handler that evaluates to false would cancel the key. */
  protected choosingWith(input: 'pointer' | 'keyboard'): void {
    this.pointerChoice = input === 'pointer';
  }

  protected choose(value: string): void {
    this.category.set(value);
    afterNextRender(
      () => {
        // The form grew: keep its buttons in view, on phones too.
        this.host.nativeElement.scrollIntoView({ block: 'nearest' });
        // Arrow keys and End also pass through "New category…": only a pointer choice moves on.
        if (value === NEW_CATEGORY && this.pointerChoice) this.nameInput()?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (!this.valid()) return;
    const type =
      this.category() === NEW_CATEGORY
        ? this.documents.addCustomCategory(this.name())
        : this.category();
    if (type) this.added.emit({ type, others: this.occurrences() > 0 && this.others() });
  }
}
