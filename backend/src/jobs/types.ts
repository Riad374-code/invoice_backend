import type { Db, Repos } from '../db/index.js';
import type { Job } from '../domain/index.js';
import type { ExtractorRegistry } from '../documents/index.js';
import type { ModelServing } from '../models/client.js';
import type { Embedder } from '../rag/clients.js';
import type { PageFetcher } from '../ingestion/fetcher.js';
import type { ObjectStorage } from '../storage/index.js';

export const QUEUES = {
  FILE_EXTRACT: 'file.extract',
  INVOICE_PARSE: 'invoice.parse',
  SOURCE_FETCH: 'source.fetch',
  SOURCES_TICK: 'sources.tick',
  SOURCES_HEALTH: 'sources.health',
  CHUNKS_INDEX: 'chunks.index',
  EMBEDDINGS_RUN: 'embeddings.run',
} as const;

export interface JobLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** Handler-lərin ehtiyacı olan asılılıqlar (HTTP-dən asılı deyil). */
export interface JobDeps {
  db: Db;
  repos: Repos;
  storage: ObjectStorage;
  extractors: ExtractorRegistry;
  fetcher?: PageFetcher;
  embedder?: Embedder;
  models?: ModelServing;
  reviewThreshold?: number;
  log: JobLogger;
}

export type JobHandler = (job: Job, deps: JobDeps) => Promise<unknown>;

/** Təkrar cəhd mənasızdır (məs. yanlış payload) → iş dərhal `dead` olur. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}
