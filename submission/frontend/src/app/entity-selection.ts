import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  viewChild,
} from '@angular/core';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { categoryDetails, categoryLabel } from './document-categories';
import { DocumentService } from './document.service';
import { LanguageService } from './language.service';

@Component({
  selector: 'app-entity-selection',
  templateUrl: './entity-selection.html',
  styleUrl: './entity-selection.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EntitySelection {
  protected readonly documents = inject(DocumentService);
  protected readonly language = inject(LanguageService);
  protected readonly categoryLabel = categoryLabel;
  protected readonly removeIcon = faXmark;
  protected readonly groups = computed(() => {
    const entities = this.documents.analysis()?.entities ?? [];
    return [...new Set(entities.map((entity) => entity.type))].map((type) => {
      const items = entities.filter((entity) => entity.type === type);
      return { type, details: categoryDetails(type), items, ids: items.map((item) => item.id) };
    });
  });
  protected readonly allIds = computed(
    () => this.documents.analysis()?.entities.map((entity) => entity.id) ?? [],
  );
  private readonly region = viewChild.required<ElementRef<HTMLElement>>('region');

  protected remove(id: string): void {
    // The button leaves with its item: keep keyboard focus in the list.
    this.region().nativeElement.focus({ preventScroll: true });
    this.documents.removeManualEntity(id);
  }
}
