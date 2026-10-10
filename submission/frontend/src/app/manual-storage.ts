import {
  CATEGORY_DETAILS,
  MAX_CATEGORY_LABEL_LENGTH,
  customCategoryCode,
  customCategoryLabel,
} from './document-categories';

/** localStorage key of the occurrences marked by hand in the last document analysed. */
export const MANUAL_STORAGE_KEY = 'manualEntities';

/** An occurrence marked by hand as the browser keeps it: where it is, never its text. */
export interface StoredMark {
  readonly start: number;
  readonly end: number;
  readonly type: string;
  readonly selected: boolean;
}

interface StoredDocument {
  /** documentFingerprint() of the document the marks belong to. */
  readonly document: string;
  readonly entities: readonly StoredMark[];
}

/**
 * Tells documents apart without keeping anything readable from them: a 64-bit hash (cyrb53) of
 * the file name, size and text. Marks are offsets into that text, so they only fit the same one.
 */
export function documentFingerprint(file: File, text: string): string {
  const value = `${file.name}\n${file.size}\n${text}`;
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first =
    Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second =
    Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return [second, first].map((part) => (part >>> 0).toString(16).padStart(8, '0')).join('');
}

/** The marks stored for this document: none when another document, or nothing valid, is stored. */
export function loadMarks(document: Document, fingerprint: string): StoredMark[] {
  try {
    const stored = JSON.parse(
      document.defaultView!.localStorage.getItem(MANUAL_STORAGE_KEY) ?? 'null',
    ) as Partial<StoredDocument> | null;
    return stored?.document === fingerprint && Array.isArray(stored.entities)
      ? stored.entities.filter(isStoredMark)
      : [];
  } catch {
    /* Storage may be unavailable or hold something else. */
    return [];
  }
}

/** Keeps these marks for this document, replacing whatever was stored for another one. */
export function saveMarks(
  document: Document,
  fingerprint: string,
  marks: readonly StoredMark[],
): void {
  const stored: StoredDocument = { document: fingerprint, entities: marks };
  try {
    document.defaultView!.localStorage.setItem(MANUAL_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* Storage may be unavailable or full. */
  }
}

function isStoredMark(mark: Partial<StoredMark> | null): mark is StoredMark {
  return (
    !!mark &&
    Number.isInteger(mark.start) &&
    Number.isInteger(mark.end) &&
    isMarkType(mark.type) &&
    typeof mark.selected === 'boolean'
  );
}

/** A built-in category code, or the code addCustomCategory() gives to a name. */
function isMarkType(type: string | undefined): boolean {
  if (typeof type !== 'string') return false;
  if (Object.prototype.hasOwnProperty.call(CATEGORY_DETAILS, type)) return true;
  const label = customCategoryLabel(type);
  return !!label && label.length <= MAX_CATEGORY_LABEL_LENGTH && customCategoryCode(label) === type;
}
