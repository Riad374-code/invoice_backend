import type {
  DocumentKind,
  ExtractionStatus,
  FileExtraction,
  FileRecord,
  FileVersion,
} from '../../domain/index.js';
import { toJson, type Db } from '../client.js';

interface FileRow {
  id: string;
  company_id: string;
  name: string;
  mime: string;
  size: string | number;
  folder: string;
  tags: string[];
  owner_id: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  [k: string]: unknown;
}
interface VersionRow {
  id: string;
  company_id: string;
  file_id: string;
  version_no: number;
  storage_key: string;
  sha256: string;
  size: string | number;
  mime: string;
  uploaded_by: string;
  created_at: Date;
  [k: string]: unknown;
}
interface ExtractionRow {
  id: string;
  company_id: string;
  file_version_id: string;
  detected_kind: DocumentKind | null;
  text: string | null;
  layout_json: unknown;
  status: ExtractionStatus;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  [k: string]: unknown;
}

const FILE_COLS = `id, company_id, name, mime, size, folder, tags, owner_id, archived_at, created_at, updated_at`;
const VERSION_COLS = `id, company_id, file_id, version_no, storage_key, sha256, size, mime, uploaded_by, created_at`;
const EXTRACTION_COLS = `id, company_id, file_version_id, detected_kind, text, layout_json, status, error, created_at, updated_at`;

const toFile = (r: FileRow): FileRecord => ({
  id: r.id,
  companyId: r.company_id,
  name: r.name,
  mime: r.mime,
  size: Number(r.size),
  folder: r.folder,
  tags: r.tags,
  ownerId: r.owner_id,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toVersion = (r: VersionRow): FileVersion => ({
  id: r.id,
  companyId: r.company_id,
  fileId: r.file_id,
  versionNo: r.version_no,
  storageKey: r.storage_key,
  sha256: r.sha256,
  size: Number(r.size),
  mime: r.mime,
  uploadedBy: r.uploaded_by,
  createdAt: r.created_at,
});
const toExtraction = (r: ExtractionRow): FileExtraction => ({
  id: r.id,
  companyId: r.company_id,
  fileVersionId: r.file_version_id,
  detectedKind: r.detected_kind,
  text: r.text,
  layoutJson: r.layout_json,
  status: r.status,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface FileListFilter {
  companyId: string;
  folder?: string | undefined;
  tag?: string | undefined;
  q?: string | undefined;
  includeArchived?: boolean | undefined;
  limit: number;
  cursor?: { createdAt: Date; id: string } | undefined;
}

export class FileRepository {
  constructor(private readonly db: Db) {}

  async create(f: FileRecord): Promise<FileRecord> {
    await this.db.query(
      `INSERT INTO files (id, company_id, name, mime, size, folder, tags, owner_id, archived_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        f.id,
        f.companyId,
        f.name,
        f.mime,
        f.size,
        f.folder,
        f.tags,
        f.ownerId,
        f.archivedAt,
        f.createdAt,
        f.updatedAt,
      ],
    );
    return f;
  }

  async findById(companyId: string, id: string): Promise<FileRecord | null> {
    const [row] = await this.db.query<FileRow>(
      `SELECT ${FILE_COLS} FROM files WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [id, companyId],
    );
    return row ? toFile(row) : null;
  }

  /** Keyset səhifələmə (created_at DESC, id DESC); `limit + 1` sətir qaytarır ki, çağıran növbəti səhifəni bilsin. */
  async list(f: FileListFilter): Promise<FileRecord[]> {
    const where = ['company_id = $1', 'deleted_at IS NULL'];
    const params: unknown[] = [f.companyId];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (!f.includeArchived) where.push('archived_at IS NULL');
    if (f.folder !== undefined) add('folder = ?', f.folder);
    if (f.tag !== undefined) add('? = ANY(tags)', f.tag.toLowerCase());
    if (f.q)
      add(
        "name ILIKE '%' || ? || '%'",
        f.q.replace(/[\\%_]/g, (c) => `\\${c}`),
      );
    if (f.cursor) {
      params.push(f.cursor.createdAt, f.cursor.id);
      where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
    }
    params.push(f.limit + 1);
    const rows = await this.db.query<FileRow>(
      `SELECT ${FILE_COLS} FROM files WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toFile);
  }

  /** Hər fayl üçün CARİ (ən yüksək versiya) extraction statusu. */
  async latestExtractionStatuses(
    companyId: string,
    fileIds: readonly string[],
  ): Promise<Map<string, ExtractionStatus>> {
    if (fileIds.length === 0) return new Map();
    const rows = await this.db.query<{ file_id: string; status: ExtractionStatus }>(
      `SELECT DISTINCT ON (v.file_id) v.file_id, e.status
         FROM file_versions v JOIN file_extractions e ON e.file_version_id = v.id
        WHERE v.company_id = $1 AND v.file_id = ANY($2::uuid[])
        ORDER BY v.file_id, v.version_no DESC`,
      [companyId, fileIds],
    );
    return new Map(rows.map((r) => [r.file_id, r.status]));
  }

  async update(
    companyId: string,
    id: string,
    patch: { name?: string; folder?: string; tags?: string[] },
    now: Date,
  ): Promise<FileRecord | null> {
    const [row] = await this.db.query<FileRow>(
      `UPDATE files SET name = COALESCE($3, name), folder = COALESCE($4, folder),
              tags = COALESCE($5, tags), updated_at = $6
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL RETURNING ${FILE_COLS}`,
      [id, companyId, patch.name ?? null, patch.folder ?? null, patch.tags ?? null, now],
    );
    return row ? toFile(row) : null;
  }

  /** İdempotent: artıq arxivlənibsə archived_at dəyişmir. */
  async archive(companyId: string, id: string, now: Date): Promise<FileRecord | null> {
    const [row] = await this.db.query<FileRow>(
      `UPDATE files SET archived_at = COALESCE(archived_at, $3), updated_at = $3
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL RETURNING ${FILE_COLS}`,
      [id, companyId, now],
    );
    return row ? toFile(row) : null;
  }

  // -------------------------------------------------------------- versions
  async createVersion(v: FileVersion): Promise<FileVersion> {
    await this.db.query(
      `INSERT INTO file_versions (id, company_id, file_id, version_no, storage_key, sha256, size, mime, uploaded_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        v.id,
        v.companyId,
        v.fileId,
        v.versionNo,
        v.storageKey,
        v.sha256,
        v.size,
        v.mime,
        v.uploadedBy,
        v.createdAt,
      ],
    );
    return v;
  }

  async listVersions(companyId: string, fileId: string): Promise<FileVersion[]> {
    const rows = await this.db.query<VersionRow>(
      `SELECT ${VERSION_COLS} FROM file_versions WHERE file_id = $1 AND company_id = $2 ORDER BY version_no DESC`,
      [fileId, companyId],
    );
    return rows.map(toVersion);
  }

  async latestVersion(companyId: string, fileId: string): Promise<FileVersion | null> {
    const [row] = await this.db.query<VersionRow>(
      `SELECT ${VERSION_COLS} FROM file_versions WHERE file_id = $1 AND company_id = $2
        ORDER BY version_no DESC LIMIT 1`,
      [fileId, companyId],
    );
    return row ? toVersion(row) : null;
  }

  async findVersion(companyId: string, versionId: string): Promise<FileVersion | null> {
    const [row] = await this.db.query<VersionRow>(
      `SELECT ${VERSION_COLS} FROM file_versions WHERE id = $1 AND company_id = $2`,
      [versionId, companyId],
    );
    return row ? toVersion(row) : null;
  }

  /** Şirkət daxilində eyni məzmun (sha256) artıq saxlanılıbsa onun storage_key-i. */
  async findStorageKeyBySha(companyId: string, sha256: string): Promise<string | null> {
    const [row] = await this.db.query<{ storage_key: string }>(
      `SELECT storage_key FROM file_versions WHERE company_id = $1 AND sha256 = $2 LIMIT 1`,
      [companyId, sha256],
    );
    return row?.storage_key ?? null;
  }

  // ----------------------------------------------------------- extractions
  async createExtraction(e: FileExtraction): Promise<FileExtraction> {
    await this.db.query(
      `INSERT INTO file_extractions (id, company_id, file_version_id, detected_kind, text, layout_json, status, error, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
      [
        e.id,
        e.companyId,
        e.fileVersionId,
        e.detectedKind,
        e.text,
        toJson(e.layoutJson),
        e.status,
        e.error,
        e.createdAt,
        e.updatedAt,
      ],
    );
    return e;
  }

  async findExtraction(
    companyId: string,
    fileVersionId: string,
    opts: { forUpdate?: boolean } = {},
  ): Promise<FileExtraction | null> {
    const [row] = await this.db.query<ExtractionRow>(
      `SELECT ${EXTRACTION_COLS} FROM file_extractions WHERE file_version_id = $1 AND company_id = $2 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [fileVersionId, companyId],
    );
    return row ? toExtraction(row) : null;
  }

  async saveExtraction(e: FileExtraction): Promise<void> {
    await this.db.query(
      `UPDATE file_extractions SET detected_kind = $2, text = $3, layout_json = $4::jsonb,
              status = $5, error = $6, updated_at = $7 WHERE id = $1`,
      [e.id, e.detectedKind, e.text, toJson(e.layoutJson), e.status, e.error, e.updatedAt],
    );
  }
}
