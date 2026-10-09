import { createRepos } from '../db/index.js';
import { detectDocument, ExtractionFailedError, NoExtractorError } from '../documents/index.js';
import { transitionExtraction, type FileExtraction } from '../domain/index.js';
import { PermanentJobError, QUEUES, type JobHandler } from './types.js';

/**
 * `file.extract` — §7 pipeline-ın skeleti: detect type → extractor → file_extractions.
 * Status: pending → extracting → ready | failed. Yeni növlər üçün yalnız extractor qeydiyyatı lazımdır.
 */
export const fileExtractHandler: JobHandler = async (job, deps) => {
  const payload = job.payload as { fileVersionId?: unknown } | null;
  const versionId = payload?.fileVersionId;
  if (typeof versionId !== 'string' || !job.companyId) {
    throw new PermanentJobError('file.extract requires companyId and payload.fileVersionId');
  }
  const companyId = job.companyId;

  // 1) pending → extracting (kilidli; paralel dublikat iş əvvəl bitibsə atlanır)
  const claimed = await deps.db.tx(async (tx) => {
    const repos = createRepos(tx);
    const extraction = await repos.files.findExtraction(companyId, versionId, { forUpdate: true });
    if (!extraction) throw new PermanentJobError(`No extraction row for file version ${versionId}`);
    if (extraction.status !== 'pending') return null;
    const next = {
      ...extraction,
      status: transitionExtraction(extraction.status, 'extracting'),
      error: null,
      updatedAt: new Date(),
    };
    await repos.files.saveExtraction(next);
    return next;
  });
  if (!claimed) return { skipped: true };

  const { repos, storage, extractors } = deps;
  const finish = (patch: Partial<FileExtraction>) =>
    repos.files.saveExtraction({ ...claimed, ...patch, updatedAt: new Date() });

  try {
    const version = await repos.files.findVersion(companyId, versionId);
    if (!version) throw new PermanentJobError(`File version ${versionId} not found`);
    const file = await repos.files.findById(companyId, version.fileId);
    if (!file) throw new PermanentJobError(`File ${version.fileId} not found`);

    const buffer = await storage.get(version.storageKey);

    // detect type (yükləmədə yoxlanılıb, amma bayt-lara yenidən baxırıq — anbar dəyişdirilə bilər)
    const detection = detectDocument(buffer, file.name, version.mime);
    if (!detection.ok)
      throw new PermanentJobError(`Stored object is not a supported document: ${detection.reason}`);
    const { kind } = detection.doc;

    try {
      const out = await extractors.extract({
        buffer,
        fileName: file.name,
        mime: version.mime,
        kind,
      });
      await finish({
        status: transitionExtraction('extracting', 'ready'),
        detectedKind: kind,
        text: out.text,
        layoutJson: out.layout,
        error: null,
      });
      if (out.text) {
        await repos.jobs.enqueue({
          queue: QUEUES.CHUNKS_INDEX,
          companyId,
          payload: { resourceType: 'file', resourceId: file.id, versionId },
          idempotencyKey: `index:file:${versionId}`,
        });
      }
      return { status: 'ready', kind };
    } catch (err) {
      if (err instanceof NoExtractorError || err instanceof ExtractionFailedError) {
        await finish({
          status: transitionExtraction('extracting', 'failed'),
          detectedKind: kind,
          error: err.message,
        });
        return {
          status: 'failed',
          kind,
          reason: err instanceof NoExtractorError ? 'no_extractor' : 'extraction_failed',
        };
      }
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const finalAttempt = err instanceof PermanentJobError || job.attempts >= job.maxAttempts;
    if (finalAttempt) {
      await finish({ status: transitionExtraction('extracting', 'failed'), error: message });
    } else {
      // keçici xəta (məs. S3 əlçatmaz): növbəti cəhd üçün pending-ə qaytar
      await finish({ status: transitionExtraction('extracting', 'pending'), error: message });
    }
    throw err;
  }
};
