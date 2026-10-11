import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { categoryDetails } from './document-categories';
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
  private readonly expandedCategories = signal<Record<string, boolean>>({});
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

  protected isCategoryOpen(type: string): boolean {
    return this.expandedCategories()[type] ?? true;
  }

  protected toggleCategory(type: string): void {
    const open = this.isCategoryOpen(type);
    this.expandedCategories.update((categories) => ({ ...categories, [type]: !open }));
  }
}
