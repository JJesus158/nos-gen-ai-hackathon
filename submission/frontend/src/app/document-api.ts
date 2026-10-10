import type { AnalyzedDocument, DocumentProcessor, ProcessedDocument } from './document-processor';

export type DocumentAnalysisApiResponse = Omit<AnalyzedDocument, 'source'>;

export interface DocumentAnonymizationApiRequest {
  /** Selected occurrences of the analysis. */
  readonly selectedEntityIds: readonly string[];
  /** Selected occurrences marked by hand, which the analysis does not know; only when present. */
  readonly manualEntities?: readonly {
    readonly start: number;
    readonly end: number;
    readonly type: string;
  }[];
}

export interface DocumentAnonymizationApiResponse {
  readonly anonymizedText: string;
  readonly download: {
    readonly name: string;
    readonly mediaType: string;
    readonly contentBase64: string;
  };
}

/** Backend analysis and file generation are separate so the user can review every occurrence. */
export function createApiProcessor(endpoint: string): DocumentProcessor {
  const base = endpoint.replace(/\/+$/, '');
  return {
    async analyze(file, signal) {
      const form = new FormData();
      form.append('file', file, file.name);
      const value = (await request(`${base}/analyze`, {
        headers: { Accept: 'application/json' },
        body: form,
        signal,
      })) as DocumentAnalysisApiResponse;
      if (
        !value ||
        typeof value.id !== 'string' ||
        !value.id.trim() ||
        typeof value.originalText !== 'string' ||
        !Array.isArray(value.entities)
      ) {
        throw new Error('Invalid API analysis response');
      }
      return { ...value, source: 'api' };
    },
    async anonymize(analysis, selectedEntityIds, signal): Promise<ProcessedDocument> {
      const selected = new Set(selectedEntityIds);
      const manual = new Set(
        analysis.entities.filter((entity) => entity.manual).map((entity) => entity.id),
      );
      const manualEntities = analysis.entities
        .filter((entity) => entity.manual && selected.has(entity.id))
        .sort((a, b) => a.start - b.start)
        .map(({ start, end, type }) => ({ start, end, type }));
      const body: DocumentAnonymizationApiRequest = {
        selectedEntityIds: selectedEntityIds.filter((id) => !manual.has(id)),
        // The key is left out when nothing was marked by hand, so those requests stay unchanged.
        ...(manualEntities.length ? { manualEntities } : {}),
      };
      const value = (await request(`${base}/${encodeURIComponent(analysis.id)}/anonymize`, {
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })) as DocumentAnonymizationApiResponse;
      if (
        !value ||
        typeof value.anonymizedText !== 'string' ||
        !value.download ||
        typeof value.download.name !== 'string' ||
        !value.download.name.trim() ||
        typeof value.download.mediaType !== 'string' ||
        !value.download.mediaType.trim() ||
        typeof value.download.contentBase64 !== 'string'
      ) {
        throw new Error('Invalid API anonymization response');
      }
      const binary = atob(value.download.contentBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return {
        originalText: analysis.originalText,
        anonymizedText: value.anonymizedText,
        entities: analysis.entities.filter((entity) => selected.has(entity.id)),
        download: {
          name: value.download.name,
          blob: new Blob([bytes], { type: value.download.mediaType }),
        },
        source: 'api',
      };
    },
  };
}

async function request(url: string, options: Omit<RequestInit, 'method'>): Promise<unknown> {
  if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const response = await fetch(url, { ...options, method: 'POST' });
  if (!response.ok) throw new Error(`Document processing failed (${response.status})`);
  return response.json();
}
