import { createRepos } from '../db/index.js';
import type { ResourceType } from '../db/repos/chunks.js';
import { chunkText } from '../rag/chunking.js';
import { toVectorLiteral } from '../rag/clients.js';
import { detectLanguage } from '../rag/lang.js';
import { PermanentJobError, QUEUES, type JobHandler } from './types.js';

const BATCH = 32;

/** `chunks.index` — resursu parçalayır (embedding sonra `embeddings.run` ilə). */
export const chunksIndexHandler: JobHandler = async (job, deps) => {
  const p = job.payload as {
    resourceType?: ResourceType;
    resourceId?: string;
    versionId?: string;
  } | null;
  if (!p?.resourceType || !p.resourceId)
    throw new PermanentJobError('chunks.index requires resourceType and resourceId');
  const { repos } = deps;

  let text: string;
  let companyId: string | null = null;
  let versionId: string | null = null;
  if (p.resourceType === 'news') {
    const n = await deps.db.query<{ title: string; raw_text: string }>(
      `SELECT title, raw_text FROM news_items WHERE id = $1`,
      [p.resourceId],
    );
    if (!n[0]) throw new PermanentJobError(`News ${p.resourceId} not found`);
    text = `${n[0].title}\n\n${n[0].raw_text}`;
  } else if (p.resourceType === 'legislation') {
    if (!p.versionId) throw new PermanentJobError('legislation indexing needs versionId');
    const v = (await repos.ingestion.listVersions(p.resourceId)).find((x) => x.id === p.versionId);
    if (!v) throw new PermanentJobError(`Legislation version ${p.versionId} not found`);
    text = v.fullText;
    versionId = v.id;
  } else if (p.resourceType === 'file') {
    if (!job.companyId || !p.versionId)
      throw new PermanentJobError('file indexing needs companyId and versionId');
    const ex = await repos.files.findExtraction(job.companyId, p.versionId);
    if (!ex || ex.status !== 'ready' || !ex.text) return { skipped: 'no extracted text' };
    text = ex.text;
    companyId = job.companyId;
    versionId = p.versionId;
  } else {
    throw new PermanentJobError(`Indexing of "${p.resourceType}" is not supported`);
  }

  const chunks = chunkText(text);
  const language = detectLanguage(text.slice(0, 2000));
  const count = await deps.db.tx((tx) =>
    createRepos(tx).chunks.replace(
      { companyId, resourceType: p.resourceType!, resourceId: p.resourceId!, versionId },
      chunks,
      { language },
    ),
  );
  // Hər indekslənmə öz embedding işini növbələyir (iş bütün gözləyənləri götürür; açar bitmiş işlə toqquşmasın)
  await repos.jobs.enqueue({
    queue: QUEUES.EMBEDDINGS_RUN,
    idempotencyKey: `embed-after:${job.id}`,
  });
  if (p.resourceType === 'news' || p.resourceType === 'legislation') {
    const kind = p.resourceType === 'news' ? 'news' : 'legislation_version';
    const sourceId = p.resourceType === 'news' ? p.resourceId : versionId!;
    // Təsir analizi embedding-lər hazır olandan sonra işləyir (hazır deyilsə iş geri çəkilmə ilə təkrar olunur)
    await repos.jobs.enqueue({
      queue: QUEUES.IMPACT_ANALYZE,
      payload: { sourceKind: kind, sourceId },
      maxAttempts: 10,
      idempotencyKey: `impact:${kind}:${sourceId}`,
    });
  }
  return { chunks: count };
};

/**
 * `embeddings.run` — gözləyən parçaları batch-lərlə embed edir. Model əlçatmazdırsa iş XƏTA ilə bitir
 * (geri çəkilmə ilə təkrar) — parça embedding-siz saxlanılır, saxta vektor yazılmır.
 */
export const embeddingsRunHandler: JobHandler = async (_job, deps) => {
  if (!deps.embedder)
    throw new PermanentJobError('No embedder configured (MODEL_SERVING_BASE_URL)');
  const embedder = deps.embedder;
  let done = 0;
  for (let i = 0; i < 100; i++) {
    const n = await deps.db.tx(async (tx) => {
      const r = createRepos(tx);
      const batch = await r.chunks.claimPending(BATCH);
      if (batch.length === 0) return 0;
      const vectors = await embedder.embed(batch.map((b) => b.text)); // xəta → tx rollback, parçalar gözləməyə qayıdır
      const now = new Date();
      for (let k = 0; k < batch.length; k++)
        await r.chunks.setEmbedding(
          batch[k]!.id,
          toVectorLiteral(vectors[k]!),
          embedder.model,
          now,
        );
      return batch.length;
    });
    if (n === 0) break;
    done += n;
  }
  return { embedded: done };
};
