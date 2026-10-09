import type { AppConfig } from './config.js';
import { ClamAvScanner, NoopScanner, type AntivirusScanner } from './security/antivirus.js';
import { MemoryStorage, S3Storage, type ObjectStorage } from './storage/index.js';

import { HttpRagOcr, withRagOcr, type RagOcrClient } from './ragocr/client.js';
import { HttpModelServing, type ModelServing } from './models/client.js';
import { HttpLlmClient, type LlmClient } from './llm/client.js';
import { HttpEmbedder, HttpReranker, type Embedder, type Reranker } from './rag/clients.js';

export interface Infra {
  embedder?: Embedder;
  reranker?: Reranker;
  llm?: LlmClient;
  models?: ModelServing;
  ragOcr?: RagOcrClient;
  storage: ObjectStorage;
  scanner: AntivirusScanner;
  warnings: string[];
}

/** Konfiqdən obyekt anbarı və antivirus skanerini qurur. Production-da fallback YOXDUR (config yoxlaması onsuz da tələb edir). */
export async function createInfra(config: AppConfig): Promise<Infra> {
  const warnings: string[] = [];
  const { s3 } = config;
  let storage: ObjectStorage;
  if (s3.bucket && s3.accessKey && s3.secretKey) {
    const s3Storage = new S3Storage({
      endpoint: s3.endpoint,
      region: s3.region ?? 'eu-central-1',
      bucket: s3.bucket,
      accessKey: s3.accessKey,
      secretKey: s3.secretKey,
    });
    if (config.appEnv !== 'production') await s3Storage.ensureBucket();
    await s3Storage.ping();
    storage = s3Storage;
  } else if (config.appEnv === 'production') {
    throw new Error('S3 storage is not configured');
  } else {
    warnings.push(
      'S3_* is not configured — using IN-MEMORY object storage (files are lost on exit).',
    );
    storage = new MemoryStorage();
  }

  let scanner: AntivirusScanner;
  if (config.antivirus.mode === 'clamav') {
    scanner = new ClamAvScanner(config.antivirus.host, config.antivirus.port);
    await scanner.ping().catch((err: unknown) => {
      warnings.push(
        `ClamAV at ${config.antivirus.mode === 'clamav' ? config.antivirus.host : ''} is not reachable yet: ${String(err)}. Uploads fail closed until it is.`,
      );
    });
  } else {
    if (config.appEnv === 'production')
      warnings.push('ANTIVIRUS IS DISABLED in production (CLAMAV_DISABLED=true).');
    scanner = new NoopScanner();
  }
  const infra: Infra = { storage, scanner, warnings };
  if (config.modelServingBaseUrl) {
    const http = { baseUrl: config.modelServingBaseUrl, apiKey: config.models.apiKey };
    infra.embedder = new HttpEmbedder(http, config.models.embedding);
    infra.reranker = new HttpReranker(http, config.models.rerank);
    infra.models = new HttpModelServing(http);
    infra.llm = new HttpLlmClient({ ...http, model: config.models.chat });
  } else {
    warnings.push(
      'MODEL_SERVING_BASE_URL is not set — embeddings/rerank disabled; search falls back to full-text only.',
    );
  }
  if (config.ragOcr) {
    infra.ragOcr = new HttpRagOcr(config.ragOcr);
    infra.models = withRagOcr(infra.models, infra.ragOcr);
  }
  return infra;
}
