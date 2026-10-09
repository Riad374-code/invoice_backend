import { createHash, randomUUID } from 'node:crypto';
import { createRepos, type Db } from '../db/index.js';
import type { FileExtraction, FileRecord, FileVersion } from '../domain/index.js';
import { blobKey, type ObjectStorage } from '../storage/index.js';

/** Sistem tərəfindən yaradılan yeni fayl (hesabat qaralaması, ixrac). Orijinal fayllara toxunmur. */
export async function createGeneratedFile(
  deps: { db: Db; storage: ObjectStorage },
  input: {
    companyId: string;
    userId: string;
    name: string;
    mime: string;
    content: Buffer;
    folder: string;
    tags: string[];
    text?: string;
  },
): Promise<FileRecord> {
  const sha256 = createHash('sha256').update(input.content).digest('hex');
  const key = blobKey(input.companyId, sha256);
  if (!(await deps.storage.exists(key)))
    await deps.storage.put(key, input.content, { contentType: input.mime, sha256 });
  const now = new Date();
  const file: FileRecord = {
    id: randomUUID(),
    companyId: input.companyId,
    name: input.name,
    mime: input.mime,
    size: input.content.length,
    folder: input.folder,
    tags: input.tags,
    ownerId: input.userId,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const version: FileVersion = {
    id: randomUUID(),
    companyId: input.companyId,
    fileId: file.id,
    versionNo: 1,
    storageKey: key,
    sha256,
    size: file.size,
    mime: input.mime,
    uploadedBy: input.userId,
    createdAt: now,
  };
  const extraction: FileExtraction = {
    id: randomUUID(),
    companyId: input.companyId,
    fileVersionId: version.id,
    detectedKind: null,
    text: input.text ?? null,
    layoutJson: null,
    status: input.text ? 'ready' : 'pending',
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await deps.db.tx(async (tx) => {
    const r = createRepos(tx);
    await r.files.create(file);
    await r.files.createVersion(version);
    await r.files.createExtraction(extraction);
  });
  return file;
}
