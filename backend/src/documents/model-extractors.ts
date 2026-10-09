import type { ModelServing } from '../models/client.js';
import { ExtractionFailedError } from './extract.js';
import { ModelResponseError } from '../models/client.js';
import { extractPdfText, looksScanned } from './pdf.js';
import type { ExtractorRegistry } from './extract.js';

/**
 * PDF/şəkil extractor-ları (BACKEND.md §7):
 *  - mətnli PDF → birbaşa mətn + layout (səhifə statistikası), model çağırılmır
 *  - skan PDF / şəkil → OCR (model-serving `/v1/ocr`)
 * OCR modeli yoxdursa skan sənəd `failed` (aydın səbəblə) olur — boş mətnlə "ready" yazılmır.
 */
export function registerModelExtractors(
  registry: ExtractorRegistry,
  models: ModelServing | undefined,
): void {
  registry.register('pdf', async ({ buffer, mime }) => {
    const pdf = await extractPdfText(buffer).catch((e: unknown) => {
      throw new ExtractionFailedError(`PDF_UNREADABLE: ${(e as Error).message}`);
    });
    if (!looksScanned(pdf)) return { text: pdf.text, layout: { method: 'text', pages: pdf.pages } };
    if (!models)
      throw new ExtractionFailedError(
        'OCR_UNAVAILABLE: scanned PDF needs the OCR model (MODEL_SERVING_BASE_URL)',
      );
    const ocr = await ocrOrFail(models, buffer, mime);
    return {
      text: ocr.text,
      layout: {
        method: 'ocr',
        pages: ocr.pages ?? pdf.pages.length,
        model: ocr.model,
        confidence: ocr.confidence ?? null,
      },
    };
  });
  registry.register('image', async ({ buffer, mime }) => {
    if (!models)
      throw new ExtractionFailedError(
        'OCR_UNAVAILABLE: images need the OCR model (MODEL_SERVING_BASE_URL)',
      );
    const ocr = await ocrOrFail(models, buffer, mime);
    return {
      text: ocr.text,
      layout: {
        method: 'ocr',
        pages: ocr.pages ?? 1,
        model: ocr.model,
        confidence: ocr.confidence ?? null,
      },
    };
  });
}

async function ocrOrFail(models: ModelServing, buffer: Buffer, mime: string) {
  try {
    return await models.ocr(buffer, mime);
  } catch (e) {
    if (e instanceof ModelResponseError)
      throw new ExtractionFailedError(`OCR_BAD_RESPONSE: ${e.message}`);
    throw e; // UpstreamError → keçici, iş təkrar cəhd olunur
  }
}
