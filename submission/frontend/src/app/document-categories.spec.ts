import { faHighlighter, faTag } from '@fortawesome/free-solid-svg-icons';
import {
  CategoryLabelKey,
  categoryDetails,
  categoryLabel,
  customCategoryCode,
  customCategoryLabel,
  isCustomCategory,
} from './document-categories';

describe('Document categories', () => {
  const text = { categoryName: 'Names', categoryOther: 'Other personal data' } as Record<
    CategoryLabelKey,
    string
  >;

  it('encodes user-defined categories with their normalized name', () => {
    expect(customCategoryCode('  Matrícula \n  escolar ')).toBe('custom:Matrícula escolar');
    expect(isCustomCategory('custom:Matrícula escolar')).toBeTrue();
    expect(isCustomCategory('custom: ')).toBeFalse();
    expect(isCustomCategory('NAME')).toBeFalse();
    expect(customCategoryLabel('custom:Matrícula escolar')).toBe('Matrícula escolar');
    expect(customCategoryLabel('NAME')).toBe('');
  });

  it('labels built-in, user-defined and unknown categories', () => {
    expect(categoryDetails('custom:Matrícula')).toEqual({
      labelKey: 'categoryOther',
      icon: faHighlighter,
      color: 'var(--accent-text)',
    });
    expect(categoryDetails('FUTURE_CATEGORY')).toEqual({
      labelKey: 'categoryOther',
      icon: faTag,
      color: 'var(--muted)',
    });
    expect(categoryLabel('NAME', text)).toBe('Names');
    expect(categoryLabel('custom:Matrícula', text)).toBe('Matrícula');
    expect(categoryLabel('FUTURE_CATEGORY', text)).toBe('Other personal data');
  });
});
