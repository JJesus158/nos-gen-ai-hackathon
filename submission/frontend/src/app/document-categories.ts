import {
  IconDefinition,
  faAddressBook,
  faBriefcase,
  faCakeCandles,
  faCalendarDay,
  faCreditCard,
  faFingerprint,
  faHeartPulse,
  faHighlighter,
  faHouseUser,
  faIdCard,
  faTag,
  faUser,
  faUserDoctor,
  faVenusMars,
} from '@fortawesome/free-solid-svg-icons';

export type CategoryLabelKey =
  | 'categoryName'
  | 'categoryId'
  | 'categoryContact'
  | 'categoryDob'
  | 'categoryFinancial'
  | 'categoryHealth'
  | 'categorySpecial'
  | 'categoryPrivateLife'
  | 'categoryAge'
  | 'categoryOccupation'
  | 'categoryClinician'
  | 'categorySex'
  | 'categoryOther';

export interface CategoryDetails {
  readonly labelKey: CategoryLabelKey;
  readonly icon: IconDefinition;
  readonly color: string;
}

export const CATEGORY_DETAILS = {
  NAME: { labelKey: 'categoryName', icon: faUser, color: 'var(--category-name)' },
  ID: { labelKey: 'categoryId', icon: faIdCard, color: 'var(--category-id)' },
  CONTACT: {
    labelKey: 'categoryContact',
    icon: faAddressBook,
    color: 'var(--category-contact)',
  },
  DOB: { labelKey: 'categoryDob', icon: faCalendarDay, color: 'var(--category-dob)' },
  FINANCIAL: {
    labelKey: 'categoryFinancial',
    icon: faCreditCard,
    color: 'var(--category-financial)',
  },
  HEALTH: { labelKey: 'categoryHealth', icon: faHeartPulse, color: 'var(--category-health)' },
  SPECIAL: {
    labelKey: 'categorySpecial',
    icon: faFingerprint,
    color: 'var(--category-special)',
  },
  PRIVATE_LIFE: {
    labelKey: 'categoryPrivateLife',
    icon: faHouseUser,
    color: 'var(--category-private-life)',
  },
  AGE: { labelKey: 'categoryAge', icon: faCakeCandles, color: 'var(--category-age)' },
  OCCUPATION: {
    labelKey: 'categoryOccupation',
    icon: faBriefcase,
    color: 'var(--category-occupation)',
  },
  CLINICIAN: {
    labelKey: 'categoryClinician',
    icon: faUserDoctor,
    color: 'var(--category-clinician)',
  },
  SEX: { labelKey: 'categorySex', icon: faVenusMars, color: 'var(--category-sex)' },
} as const satisfies Record<string, CategoryDetails>;

const other: CategoryDetails = {
  labelKey: 'categoryOther',
  icon: faTag,
  color: 'var(--muted)',
};

const custom: CategoryDetails = {
  labelKey: 'categoryOther',
  icon: faHighlighter,
  color: 'var(--accent-text)',
};

/** Categories the user creates on the review screen are encoded as `custom:<label>`. */
export const CUSTOM_CATEGORY_PREFIX = 'custom:';
export const MAX_CATEGORY_LABEL_LENGTH = 40;

/** A user-defined category name, trimmed and with its inner whitespace collapsed. */
export function normalizeCategoryLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ');
}

export function customCategoryCode(label: string): string {
  return CUSTOM_CATEGORY_PREFIX + normalizeCategoryLabel(label);
}

export function isCustomCategory(type: string): boolean {
  return (
    type.startsWith(CUSTOM_CATEGORY_PREFIX) && !!type.slice(CUSTOM_CATEGORY_PREFIX.length).trim()
  );
}

export function customCategoryLabel(type: string): string {
  return isCustomCategory(type) ? type.slice(CUSTOM_CATEGORY_PREFIX.length) : '';
}

export function categoryDetails(type: string): CategoryDetails {
  if (Object.prototype.hasOwnProperty.call(CATEGORY_DETAILS, type))
    return CATEGORY_DETAILS[type as keyof typeof CATEGORY_DETAILS];
  return isCustomCategory(type) ? custom : other;
}

/** Translated category label; a user-defined category keeps the name the user gave it. */
export function categoryLabel(
  type: string,
  text: Readonly<Record<CategoryLabelKey, string>>,
): string {
  return isCustomCategory(type) ? customCategoryLabel(type) : text[categoryDetails(type).labelKey];
}
