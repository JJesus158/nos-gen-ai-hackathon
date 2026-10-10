import { InjectionToken, inject } from '@angular/core';
import { createApiProcessor } from './document-api';
import { exampleDocumentProcessor } from './example-document';

export interface DocumentEntity {
  /** Unique within this analysis, including repeated occurrences of the same value. */
  readonly id: string;
  /** UTF-16 offsets in originalText; start is inclusive and end is exclusive. */
  readonly start: number;
  readonly end: number;
  readonly type: string;
  readonly replacement: string;
  readonly reason?: string;
  /** Frontend only: marked by the user on the review screen, never part of a processor analysis. */
  readonly manual?: boolean;
}

export interface AnalyzedDocument {
  readonly id: string;
  readonly originalText: string;
  readonly entities: readonly DocumentEntity[];
  readonly source: 'example' | 'api';
}

/** Frontend result model. The API adapter must map its response into this shape. */
export interface ProcessedDocument {
  readonly originalText: string;
  readonly anonymizedText: string;
  readonly entities: readonly DocumentEntity[];
  readonly download: { readonly name: string; readonly blob: Blob };
  readonly source: 'example' | 'api';
}

export interface DocumentProcessor {
  analyze(file: File, signal: AbortSignal): Promise<AnalyzedDocument>;
  anonymize(
    analysis: AnalyzedDocument,
    selectedEntityIds: readonly string[],
    signal: AbortSignal,
  ): Promise<ProcessedDocument>;
  /** The anonymized document rewritten as readable text, in `language` ('en' or 'pt-PT'). */
  summarize(
    analysis: AnalyzedDocument,
    selectedEntityIds: readonly string[],
    language: string,
    signal: AbortSignal,
  ): Promise<string>;
}

/** null keeps processing local; configure the agreed endpoint to enable HTTP. */
export const DOCUMENT_API_URL = new InjectionToken<string | null>('DOCUMENT_API_URL', {
  providedIn: 'root',
  factory: () => null,
});

/** Components and workflow state use the same contract in local and API modes. */
export const DOCUMENT_PROCESSOR = new InjectionToken<DocumentProcessor>('DOCUMENT_PROCESSOR', {
  providedIn: 'root',
  factory: () => {
    const endpoint = inject(DOCUMENT_API_URL);
    return endpoint ? createApiProcessor(endpoint) : exampleDocumentProcessor;
  },
});
