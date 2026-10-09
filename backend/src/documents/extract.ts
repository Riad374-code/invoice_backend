import type { DocumentKind } from '../domain/index.js';
import { stripBom } from './detect.js';

export interface ExtractInput {
  buffer: Buffer;
  fileName: string;
  mime: string;
  kind: DocumentKind;
}

export interface ExtractOutput {
  text: string | null;
  layout: unknown;
}

export type Extractor = (input: ExtractInput) => Promise<ExtractOutput>;

/** Bu növ üçün hələ extractor qeydiyyatdan keçməyib → pipeline "failed" olur (sonradan reindex ilə təkrarlanır). */
export class NoExtractorError extends Error {
  constructor(readonly kind: DocumentKind) {
    super(`NO_EXTRACTOR: no extractor registered for document kind "${kind}"`);
    this.name = 'NoExtractorError';
  }
}

/** Təkrar cəhdin mənası olmayan çıxarış xətası (pozuq fayl, OCR modeli konfiq olunmayıb…) → status `failed`. */
export class ExtractionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionFailedError';
  }
}

const MAX_TEXT_CHARS = 5_000_000;

const plainText: Extractor = async ({ buffer, kind }) => {
  const full = stripBom(buffer.toString('utf8'));
  const truncated = full.length > MAX_TEXT_CHARS;
  return {
    text: truncated ? full.slice(0, MAX_TEXT_CHARS) : full,
    layout: { kind, chars: full.length, truncated },
  };
};

/**
 * Extractor reyestri. B4: yalnız mətn əsaslı formatlar. PDF/OCR (B10), XML qaimə (B6), Excel (B12)
 * öz extractor-larını `register` ilə əlavə edəcək — pipeline kodu dəyişmir.
 */
export class ExtractorRegistry {
  private readonly extractors = new Map<DocumentKind, Extractor>();

  constructor() {
    this.register('text', plainText);
    this.register('csv', plainText);
    this.register('xml', plainText);
  }

  register(kind: DocumentKind, extractor: Extractor): void {
    this.extractors.set(kind, extractor);
  }

  async extract(input: ExtractInput): Promise<ExtractOutput> {
    const extractor = this.extractors.get(input.kind);
    if (!extractor) throw new NoExtractorError(input.kind);
    return extractor(input);
  }
}
