import type { Db } from '../client.js';

type R = Record<string, unknown>;

export type ResourceType = 'legislation' | 'news' | 'file' | 'audit';

export interface ChunkScope {
  companyId: string | null;
  resourceType: ResourceType;
  resourceId: string;
  versionId: string | null;
}

export interface SearchFilter {
  companyId: string;
  resourceTypes: readonly ResourceType[];
  /** Qanun parçaları üçün: bu tarixdə qüvvədə olan versiya */
  date: string;
  jurisdiction: string;
  limit: number;
  /** Vektor yolu üçün minimum cosine oxşarlığı (0..1). Onsuz ANN həmişə "ən yaxın" nəticə qaytarır, mənbəsizlik aşkarlanmaz. */
  minSimilarity?: number;
}

export interface ChunkHit {
  id: string;
  resourceType: ResourceType;
  resourceId: string;
  versionId: string | null;
  articleRef: string | null;
  text: string;
  title: string;
  versionNo: number | null;
  url: string | null;
}

const SELECT = `c.id, c.resource_type, c.resource_id, c.version_id, c.article_ref, c.text,
  COALESCE(n.title, d.title, f.name, 'audit') AS title, lv.version_no, COALESCE(n.original_url, d.source_url) AS url
  FROM chunks c
  LEFT JOIN news_items n ON c.resource_type = 'news' AND n.id = c.resource_id
  LEFT JOIN legislation_documents d ON c.resource_type = 'legislation' AND d.id = c.resource_id
  LEFT JOIN legislation_versions lv ON c.resource_type = 'legislation' AND lv.id = c.version_id
  LEFT JOIN files f ON c.resource_type = 'file' AND f.id = c.resource_id AND f.company_id = c.company_id`;

const toHit = (r: R): ChunkHit => ({
  id: r['id'] as string,
  resourceType: r['resource_type'] as ResourceType,
  resourceId: r['resource_id'] as string,
  versionId: r['version_id'] as string | null,
  articleRef: r['article_ref'] as string | null,
  text: r['text'] as string,
  title: r['title'] as string,
  versionNo: r['version_no'] as number | null,
  url: r['url'] as string | null,
});

/** Tenant + icazə + yurisdiksiya + tarix filtri: hər iki axtarış yolunda EYNİDİR. */
function scopeWhere(f: SearchFilter, params: unknown[]): string {
  params.push(f.companyId, [...f.resourceTypes], f.jurisdiction, f.date);
  const [co, types, jur, date] = [
    params.length - 3,
    params.length - 2,
    params.length - 1,
    params.length,
  ];
  return `(c.company_id IS NULL OR c.company_id = $${co}::uuid)
    AND c.resource_type = ANY($${types}::text[])
    AND c.jurisdiction = $${jur}
    AND (c.resource_type <> 'legislation' OR (lv.valid_from <= $${date}::date AND (lv.valid_to IS NULL OR lv.valid_to >= $${date}::date)))`;
}

export class ChunkRepository {
  constructor(private readonly db: Db) {}

  /**
   * Resursun parçalarını əvəz edir (embedding sonra növbə ilə hesablanır).
   * Qanun: hər versiyanın öz parçaları qalır (tarixə görə axtarış üçün). Digərləri: köhnə parçalar silinir.
   */
  async replace(
    scope: ChunkScope,
    chunks: Array<{ chunkNo: number; articleRef: string | null; text: string }>,
    meta: { language: string | null; jurisdiction?: string },
  ): Promise<number> {
    if (scope.resourceType === 'legislation') {
      await this.db.query(
        `DELETE FROM chunks WHERE resource_type = 'legislation' AND resource_id = $1 AND version_id = $2`,
        [scope.resourceId, scope.versionId],
      );
    } else {
      await this.db.query(`DELETE FROM chunks WHERE resource_type = $1 AND resource_id = $2`, [
        scope.resourceType,
        scope.resourceId,
      ]);
    }
    for (const c of chunks) {
      await this.db.query(
        `INSERT INTO chunks (company_id, resource_type, resource_id, version_id, chunk_no, article_ref, jurisdiction, language, text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          scope.companyId,
          scope.resourceType,
          scope.resourceId,
          scope.versionId,
          c.chunkNo,
          c.articleRef,
          meta.jurisdiction ?? 'AZ',
          meta.language,
          c.text,
        ],
      );
    }
    return chunks.length;
  }

  /** Embedding gözləyən parçaları kilidləyir (SKIP LOCKED — paralel işçilər üst-üstə düşmür). Yalnız tx daxilində. */
  async claimPending(limit: number): Promise<Array<{ id: string; text: string }>> {
    const rows = await this.db.query<R>(
      `SELECT id, text FROM chunks WHERE embedding IS NULL ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return rows.map((r) => ({ id: r['id'] as string, text: r['text'] as string }));
  }

  async setEmbedding(id: string, vector: string, model: string, now: Date): Promise<void> {
    await this.db.query(
      `UPDATE chunks SET embedding = $2::vector, embedding_model = $3, embedded_at = $4 WHERE id = $1`,
      [id, vector, model, now],
    );
  }

  async pendingCount(): Promise<number> {
    const [r] = await this.db.query<R>(
      `SELECT count(*)::int AS n FROM chunks WHERE embedding IS NULL`,
    );
    return (r?.['n'] as number) ?? 0;
  }

  async vectorSearch(queryVector: string, model: string, f: SearchFilter): Promise<ChunkHit[]> {
    const params: unknown[] = [queryVector, model];
    const where = scopeWhere(f, params);
    params.push(f.minSimilarity ?? 0);
    const simIdx = params.length;
    params.push(f.limit);
    // Başqa modellə hesablanmış vektorlar müqayisə olunmur (fərqli fəza)
    const rows = await this.db.query<R>(
      `SELECT ${SELECT} WHERE c.embedding IS NOT NULL AND c.embedding_model = $2 AND (1 - (c.embedding <=> $1::vector)) >= $${simIdx} AND ${where}
       ORDER BY c.embedding <=> $1::vector, c.id LIMIT $${params.length}`,
      params,
    );
    return rows.map(toHit);
  }

  /** `tsQuery` — rag/query.ts-in qurduğu təhlükəsiz prefiks sorğusu (yalnız hərf/rəqəm tokenləri). */
  async fullTextSearch(tsQuery: string, f: SearchFilter): Promise<ChunkHit[]> {
    if (!tsQuery) return [];
    const params: unknown[] = [tsQuery];
    const where = scopeWhere(f, params);
    params.push(f.limit);
    const rows = await this.db.query<R>(
      `SELECT ${SELECT} WHERE c.tsv @@ to_tsquery('simple', $1) AND ${where}
       ORDER BY ts_rank_cd(c.tsv, to_tsquery('simple', $1)) DESC, c.id LIMIT $${params.length}`,
      params,
    );
    return rows.map(toHit);
  }
}
