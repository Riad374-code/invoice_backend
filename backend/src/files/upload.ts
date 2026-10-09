import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditRequest } from '../audit/http.js';
import { createRepos } from '../db/index.js';
import type { EnqueueInput } from '../db/repos/jobs.js';
import { detectDocument } from '../documents/index.js';
import {
  DomainError,
  normalizeFolder,
  normalizeTags,
  sanitizeFileName,
  type FileExtraction,
  type FileRecord,
  type FileVersion,
} from '../domain/index.js';
import { ApiError } from '../error.js';
import { QUEUES } from '../jobs/types.js';
import { requireAuth } from '../plugins/auth.js';
import { ScannerUnavailableError } from '../security/antivirus.js';
import { StorageError, blobKey } from '../storage/index.js';

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((t) => typeof t === 'string')) return parsed;
    } catch {
      /* aşağıda 422 */
    }
    throw ApiError.validation('tags must be a JSON array of strings or a comma-separated list');
  }
  return trimmed.split(',');
}

/** Domain doğrulama xətalarını (ad/qovluq/teq) 422-yə çevirir. */
export function validated<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof DomainError && err.kind === 'VALIDATION')
      throw ApiError.validation(err.message);
    throw err;
  }
}

export interface IngestHooks {
  /** Yükləmə ilə eyni transaksiyada əlavə növbələnən işlər (məs. invoice.parse). */
  extraJobs?: (version: FileVersion) => Array<Omit<EnqueueInput, 'companyId'>>;
}

/** multipart yükləmə → yoxlamalar → S3 → files/versions/extraction + job + audit. Həm /files, həm /invoices/upload istifadə edir. */
export async function ingestUpload(
  app: FastifyInstance,
  request: FastifyRequest,
  hooks: IngestHooks = {},
): Promise<{ file: FileRecord; version: FileVersion; extraction: FileExtraction }> {
  const auth = requireAuth(request);
  if (!request.isMultipart())
    throw ApiError.validation('Content-Type must be multipart/form-data', 415);

  let upload: { buffer: Buffer; fileName: string; mimetype: string } | undefined;
  const fields: Record<string, string> = {};
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (part.fieldname !== 'file' || upload) {
        part.file.resume(); // artıq/gözlənilməz fayl hissəsi
        throw ApiError.validation('Exactly one file field named "file" is allowed');
      }
      // fileSize limiti aşılsa burada 413 atılır (FST_REQ_FILE_TOO_LARGE)
      upload = {
        buffer: await part.toBuffer(),
        fileName: part.filename,
        mimetype: part.mimetype,
      };
    } else if (typeof part.value === 'string') {
      fields[part.fieldname] = part.value;
    }
  }
  if (!upload) throw ApiError.validation('Missing "file" field');

  const name = validated(() => sanitizeFileName(fields['name'] || upload.fileName || ''));
  const folder = validated(() => normalizeFolder(fields['folder']));
  const tags = validated(() => normalizeTags(parseTags(fields['tags'])));

  // §11: MIME yoxlaması (məzmun əsasında)
  const detection = detectDocument(upload.buffer, name, upload.mimetype);
  if (!detection.ok) throw ApiError.validation(detection.reason);
  const { mime } = detection.doc;

  // §11: antivirus (əlçatmazdırsa fail-closed)
  try {
    const scan = await app.ctx.scanner.scan(upload.buffer);
    if (!scan.clean) {
      request.log.warn(
        { signature: scan.signature, companyId: auth.companyId },
        'upload rejected by antivirus',
      );
      throw ApiError.validation(`File rejected by antivirus scan (${scan.signature})`);
    }
  } catch (err) {
    if (err instanceof ScannerUnavailableError) {
      request.log.error({ err }, 'antivirus scanner unavailable');
      throw ApiError.upstream('Antivirus scanner is unavailable; upload was not accepted');
    }
    throw err;
  }

  // S3: content-addressed açar → eyni məzmun bir dəfə saxlanılır (sha256 dedupe)
  const sha256 = createHash('sha256').update(upload.buffer).digest('hex');
  const storageKey = blobKey(auth.companyId, sha256);
  let deduplicated = false;
  try {
    if (await app.ctx.storage.exists(storageKey)) deduplicated = true;
    else await app.ctx.storage.put(storageKey, upload.buffer, { contentType: mime, sha256 });
  } catch (err) {
    if (err instanceof StorageError) {
      request.log.error({ err }, 'object storage failure');
      throw ApiError.upstream('Object storage is unavailable');
    }
    throw err;
  }

  const now = new Date();
  const file: FileRecord = {
    id: randomUUID(),
    companyId: auth.companyId,
    name,
    mime,
    size: upload.buffer.length,
    folder,
    tags,
    ownerId: auth.userId,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const version: FileVersion = {
    id: randomUUID(),
    companyId: auth.companyId,
    fileId: file.id,
    versionNo: 1,
    storageKey,
    sha256,
    size: file.size,
    mime,
    uploadedBy: auth.userId,
    createdAt: now,
  };
  const extraction: FileExtraction = {
    id: randomUUID(),
    companyId: auth.companyId,
    fileVersionId: version.id,
    detectedKind: detection.doc.kind,
    text: null,
    layoutJson: null,
    status: 'pending',
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  await app.ctx.db.tx(async (tx) => {
    const repos = createRepos(tx);
    await repos.files.create(file);
    await repos.files.createVersion(version);
    await repos.files.createExtraction(extraction);
    await repos.jobs.enqueue(
      {
        queue: QUEUES.FILE_EXTRACT,
        companyId: auth.companyId,
        payload: { fileVersionId: version.id },
        idempotencyKey: `extract:${version.id}`,
      },
      now,
    );
    for (const job of hooks.extraJobs?.(version) ?? []) {
      await repos.jobs.enqueue({ ...job, companyId: auth.companyId }, now);
    }
    await auditRequest(
      app,
      request,
      {
        action: 'file.upload',
        resourceType: 'file',
        resourceId: file.id,
        after: { name, mime, size: file.size, folder, tags, sha256, deduplicated },
      },
      tx,
    );
  });

  return { file, version, extraction };
}
