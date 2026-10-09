import { approvalsExpireHandler, feedbackExportHandler } from './maintenance.js';
import { impactAnalyzeHandler, newsEnrichHandler } from './impact.js';
import { excelRunHandler } from './excel.js';
import { fileExtractHandler } from './file-extract.js';
import {
  fxCbarHandler,
  sourceFetchHandler,
  sourcesHealthHandler,
  sourcesTickHandler,
} from './ingestion.js';
import { chunksIndexHandler, embeddingsRunHandler } from './rag.js';
import { invoiceParseHandler } from './invoice-parse.js';
import { QUEUES, type JobHandler } from './types.js';

/** Növbə adı → handler. Yeni fon işləri (B7+) bura əlavə olunur. */
export function buildHandlers(): Record<string, JobHandler> {
  return {
    [QUEUES.FILE_EXTRACT]: fileExtractHandler,
    [QUEUES.INVOICE_PARSE]: invoiceParseHandler,
    [QUEUES.SOURCE_FETCH]: sourceFetchHandler,
    [QUEUES.SOURCES_TICK]: sourcesTickHandler,
    [QUEUES.SOURCES_HEALTH]: sourcesHealthHandler,
    [QUEUES.FX_CBAR]: fxCbarHandler,
    [QUEUES.EXCEL_RUN]: excelRunHandler,
    [QUEUES.NEWS_ENRICH]: newsEnrichHandler,
    [QUEUES.FEEDBACK_EXPORT]: feedbackExportHandler,
    [QUEUES.APPROVALS_EXPIRE]: approvalsExpireHandler,
    [QUEUES.IMPACT_ANALYZE]: impactAnalyzeHandler,
    [QUEUES.CHUNKS_INDEX]: chunksIndexHandler,
    [QUEUES.EMBEDDINGS_RUN]: embeddingsRunHandler,
  };
}
