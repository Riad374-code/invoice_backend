import { toJson, type Db } from '../client.js';

type R = Record<string, unknown>;

export interface SourceRow {
  id: string;
  name: string;
  url: string;
  type: 'official' | 'news';
  kind: 'news' | 'legislation';
  adapter: 'rss' | 'html_list' | 'html_document' | null;
  config: Record<string, unknown>;
  fetchCron: string;
  enabled: boolean;
}
export interface NewsRow {
  id: string;
  sourceId: string;
  title: string;
  originalUrl: string;
  canonicalUrl: string;
  publishedAt: Date | null;
  rawText: string;
  aiSummary: string | null;
  aiCategory: string | null;
  aiRiskLevel: string | null;
  aiTags: string[] | null;
  fetchedAt: Date;
  read: boolean;
  bookmarked: boolean;
}
export interface LegDocRow {
  id: string;
  type: string;
  officialNumber: string | null;
  adoptedAt: string | null;
  title: string;
  language: string;
  sourceUrl: string;
  canonicalUrl: string;
  latestVersionNo: number | null;
  currentValidFrom: string | null;
}
export interface LegVersionRow {
  id: string;
  documentId: string;
  versionNo: number;
  validFrom: string;
  validTo: string | null;
  fullText: string;
  sourceUrl: string;
  contentHash: string;
}

const toSource = (r: R): SourceRow => ({
  id: r['id'] as string,
  name: r['name'] as string,
  url: r['url'] as string,
  type: r['type'] as SourceRow['type'],
  kind: r['kind'] as SourceRow['kind'],
  adapter: r['adapter'] as SourceRow['adapter'],
  config: (r['config'] ?? {}) as Record<string, unknown>,
  fetchCron: r['fetch_cron'] as string,
  enabled: r['enabled'] as boolean,
});
const toVersion = (r: R): LegVersionRow => ({
  id: r['id'] as string,
  documentId: r['document_id'] as string,
  versionNo: r['version_no'] as number,
  validFrom: r['valid_from'] as string,
  validTo: r['valid_to'] as string | null,
  fullText: r['full_text'] as string,
  sourceUrl: r['source_url'] as string,
  contentHash: (r['content_hash'] as string).trim(),
});
const VER = `id, document_id, version_no, valid_from::text AS valid_from, valid_to::text AS valid_to, full_text, source_url, content_hash`;
const SRC = `id, name, url, type, kind, adapter, config, fetch_cron, enabled`;

export class IngestionRepository {
  constructor(private readonly db: Db) {}

  // ------------------------------------------------------------ sources
  async listSources(opts: { enabledOnly?: boolean } = {}): Promise<SourceRow[]> {
    const rows = await this.db.query<R>(
      `SELECT ${SRC} FROM sources ${opts.enabledOnly ? 'WHERE enabled' : ''} ORDER BY name`,
    );
    return rows.map(toSource);
  }
  async getSource(id: string): Promise<SourceRow | null> {
    const [r] = await this.db.query<R>(`SELECT ${SRC} FROM sources WHERE id = $1`, [id]);
    return r ? toSource(r) : null;
  }
  async updateSource(
    id: string,
    p: { adapter?: string | null; config?: unknown; enabled?: boolean; fetchCron?: string },
  ): Promise<void> {
    await this.db.query(
      `UPDATE sources SET adapter = COALESCE($2, adapter), config = COALESCE($3::jsonb, config), enabled = COALESCE($4, enabled),
              fetch_cron = COALESCE($5, fetch_cron), updated_at = NOW() WHERE id = $1`,
      [
        id,
        p.adapter ?? null,
        p.config === undefined ? null : toJson(p.config),
        p.enabled ?? null,
        p.fetchCron ?? null,
      ],
    );
  }

  // --------------------------------------------------------- fetch runs
  async startRun(sourceId: string, now: Date): Promise<string> {
    const [r] = await this.db.query<{ id: string }>(
      `INSERT INTO fetch_runs (source_id, started_at) VALUES ($1,$2) RETURNING id`,
      [sourceId, now],
    );
    return r!.id;
  }
  async finishRun(
    id: string,
    f: {
      status: 'success' | 'partial' | 'failed';
      itemsNew: number;
      itemsSeen: number;
      error: string | null;
    },
    now: Date,
  ): Promise<void> {
    await this.db.query(
      `UPDATE fetch_runs SET status=$2, items_new=$3, items_seen=$4, error=$5, finished_at=$6 WHERE id=$1`,
      [id, f.status, f.itemsNew, f.itemsSeen, f.error?.slice(0, 4000) ?? null, now],
    );
  }
  async lastRunStart(sourceId: string): Promise<Date | null> {
    const [r] = await this.db.query<R>(
      `SELECT max(started_at) AS t FROM fetch_runs WHERE source_id = $1`,
      [sourceId],
    );
    return (r?.['t'] as Date | null) ?? null;
  }
  async lastSuccess(sourceId: string): Promise<Date | null> {
    const [r] = await this.db.query<R>(
      `SELECT max(finished_at) AS t FROM fetch_runs WHERE source_id = $1 AND status IN ('success','partial')`,
      [sourceId],
    );
    return (r?.['t'] as Date | null) ?? null;
  }
  async listRuns(
    sourceId: string,
    limit = 20,
  ): Promise<
    Array<{
      id: string;
      startedAt: Date;
      finishedAt: Date | null;
      status: string;
      itemsNew: number;
      error: string | null;
    }>
  > {
    const rows = await this.db.query<R>(
      `SELECT id, started_at, finished_at, status, items_new, error FROM fetch_runs WHERE source_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [sourceId, limit],
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      startedAt: r['started_at'] as Date,
      finishedAt: r['finished_at'] as Date | null,
      status: r['status'] as string,
      itemsNew: r['items_new'] as number,
      error: r['error'] as string | null,
    }));
  }

  // --------------------------------------------------------------- news
  async newsExists(canonicalUrl: string): Promise<boolean> {
    return (
      (await this.db.query(`SELECT 1 FROM news_items WHERE canonical_url = $1`, [canonicalUrl]))
        .length > 0
    );
  }
  /** @returns yeni elementin id-si; dublikatdırsa null (canonical_url unikaldır). */
  async insertNews(
    n: {
      sourceId: string;
      title: string;
      originalUrl: string;
      canonicalUrl: string;
      contentHash: string;
      publishedAt: Date | null;
      rawText: string;
    },
    now: Date,
  ): Promise<string | null> {
    const rows = await this.db.query(
      `INSERT INTO news_items (source_id, title, original_url, canonical_url, content_hash, published_at, raw_text, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (canonical_url) DO NOTHING RETURNING id`,
      [
        n.sourceId,
        n.title,
        n.originalUrl,
        n.canonicalUrl,
        n.contentHash,
        n.publishedAt,
        n.rawText,
        now,
      ],
    );
    return (rows[0] as { id: string } | undefined)?.id ?? null;
  }
  private newsSelect(userParam: string) {
    return `n.id, n.source_id, n.title, n.original_url, n.canonical_url, n.published_at, n.raw_text, n.ai_summary, n.ai_category,
            n.ai_risk_level, n.ai_tags, n.fetched_at, (s.read_at IS NOT NULL) AS read, COALESCE(s.bookmarked, FALSE) AS bookmarked
       FROM news_items n LEFT JOIN news_user_state s ON s.news_item_id = n.id AND s.user_id = ${userParam}`;
  }
  private toNews(r: R): NewsRow {
    return {
      id: r['id'] as string,
      sourceId: r['source_id'] as string,
      title: r['title'] as string,
      originalUrl: r['original_url'] as string,
      canonicalUrl: r['canonical_url'] as string,
      publishedAt: r['published_at'] as Date | null,
      rawText: r['raw_text'] as string,
      aiSummary: r['ai_summary'] as string | null,
      aiCategory: r['ai_category'] as string | null,
      aiRiskLevel: r['ai_risk_level'] as string | null,
      aiTags: r['ai_tags'] as string[] | null,
      fetchedAt: r['fetched_at'] as Date,
      read: r['read'] as boolean,
      bookmarked: r['bookmarked'] as boolean,
    };
  }
  async listNews(
    userId: string,
    f: {
      sourceId?: string | undefined;
      unread?: boolean | undefined;
      bookmarked?: boolean | undefined;
      q?: string | undefined;
      limit: number;
      cursor?: { t: string; id: string } | undefined;
    },
  ): Promise<NewsRow[]> {
    const where: string[] = [];
    const params: unknown[] = [userId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.sourceId) add('n.source_id = ?', f.sourceId);
    if (f.unread) where.push('s.read_at IS NULL');
    if (f.bookmarked) where.push('COALESCE(s.bookmarked, FALSE)');
    if (f.q)
      add(
        "(n.title ILIKE '%' || ? || '%' OR n.raw_text ILIKE '%' || ? || '%')",
        f.q.replace(/[\\%_]/g, (c) => `\\${c}`),
      );
    if (f.cursor) {
      params.push(f.cursor.t, f.cursor.id);
      where.push(
        `(COALESCE(n.published_at, n.fetched_at), n.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    params.push(f.limit + 1);
    const rows = await this.db.query<R>(
      `SELECT ${this.newsSelect('$1')} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(n.published_at, n.fetched_at) DESC, n.id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => this.toNews(r));
  }
  async getNews(userId: string, id: string): Promise<NewsRow | null> {
    const [r] = await this.db.query<R>(`SELECT ${this.newsSelect('$1')} WHERE n.id = $2`, [
      userId,
      id,
    ]);
    return r ? this.toNews(r) : null;
  }
  async setNewsState(
    userId: string,
    companyId: string,
    newsId: string,
    p: { read?: boolean; bookmarked?: boolean },
    now: Date,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO news_user_state (user_id, news_item_id, company_id, read_at, bookmarked, updated_at)
       VALUES ($1,$2,$3, CASE WHEN $4::boolean THEN $6::timestamptz END, COALESCE($5::boolean, FALSE), $6)
       ON CONFLICT (user_id, news_item_id) DO UPDATE SET
         read_at = CASE WHEN $4::boolean IS NULL THEN news_user_state.read_at WHEN $4::boolean THEN COALESCE(news_user_state.read_at, $6::timestamptz) ELSE NULL END,
         bookmarked = COALESCE($5::boolean, news_user_state.bookmarked), updated_at = $6`,
      [userId, newsId, companyId, p.read ?? null, p.bookmarked ?? null, now],
    );
  }

  // -------------------------------------------------------- legislation
  /** Sənədi canonical URL-ə görə tapır/yaradır. */
  async upsertDocument(d: {
    sourceId: string | null;
    type: string;
    officialNumber: string | null;
    adoptedAt: string | null;
    title: string;
    language: string;
    sourceUrl: string;
    canonicalUrl: string;
  }): Promise<{ id: string; created: boolean }> {
    const [r] = await this.db.query<R>(
      `INSERT INTO legislation_documents (source_id, type, official_number, adopted_at, title, language, source_url, canonical_url)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8)
       ON CONFLICT (canonical_url) DO UPDATE SET title = EXCLUDED.title, updated_at = NOW()
       RETURNING id, (xmax = 0) AS created`,
      [
        d.sourceId,
        d.type,
        d.officialNumber,
        d.adoptedAt,
        d.title,
        d.language,
        d.sourceUrl,
        d.canonicalUrl,
      ],
    );
    return { id: r!['id'] as string, created: r!['created'] as boolean };
  }
  async lockDocument(id: string): Promise<void> {
    await this.db.query(`SELECT 1 FROM legislation_documents WHERE id = $1 FOR UPDATE`, [id]);
  }
  async latestVersion(documentId: string): Promise<LegVersionRow | null> {
    const [r] = await this.db.query<R>(
      `SELECT ${VER} FROM legislation_versions WHERE document_id = $1 ORDER BY version_no DESC LIMIT 1`,
      [documentId],
    );
    return r ? toVersion(r) : null;
  }
  /** Əvvəlki versiyanı bağlayır (valid_to = yeni.valid_from − 1 gün) və yenisini yazır. */
  async addVersion(
    documentId: string,
    v: { validFrom: string; fullText: string; sourceUrl: string; contentHash: string },
  ): Promise<{ id: string; versionNo: number }> {
    const prev = await this.latestVersion(documentId);
    if (prev) {
      await this.db.query(
        `UPDATE legislation_versions SET valid_to = ($2::date - 1) WHERE id = $1`,
        [prev.id, v.validFrom],
      );
    }
    const versionNo = (prev?.versionNo ?? 0) + 1;
    const [row] = await this.db.query<{ id: string }>(
      `INSERT INTO legislation_versions (document_id, version_no, valid_from, valid_to, full_text, source_url, content_hash) VALUES ($1,$2,$3::date,NULL,$4,$5,$6) RETURNING id`,
      [documentId, versionNo, v.validFrom, v.fullText, v.sourceUrl, v.contentHash],
    );
    return { id: row!.id, versionNo };
  }
  async listDocuments(f: {
    type?: string | undefined;
    q?: string | undefined;
    limit: number;
    offset: number;
  }): Promise<LegDocRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.type) add('d.type = ?', f.type);
    if (f.q)
      add(
        "d.title ILIKE '%' || ? || '%'",
        f.q.replace(/[\\%_]/g, (c) => `\\${c}`),
      );
    params.push(f.limit, f.offset);
    const rows = await this.db.query<R>(
      `SELECT d.id, d.type, d.official_number, d.adopted_at::text AS adopted_at, d.title, d.language, d.source_url, d.canonical_url,
              (SELECT max(version_no) FROM legislation_versions v WHERE v.document_id = d.id) AS latest_no,
              (SELECT valid_from::text FROM legislation_versions v WHERE v.document_id = d.id AND v.valid_to IS NULL LIMIT 1) AS current_from
         FROM legislation_documents d ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.title, d.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map((r) => this.toDoc(r));
  }
  private toDoc(r: R): LegDocRow {
    return {
      id: r['id'] as string,
      type: r['type'] as string,
      officialNumber: r['official_number'] as string | null,
      adoptedAt: r['adopted_at'] as string | null,
      title: r['title'] as string,
      language: r['language'] as string,
      sourceUrl: r['source_url'] as string,
      canonicalUrl: r['canonical_url'] as string,
      latestVersionNo: r['latest_no'] as number | null,
      currentValidFrom: r['current_from'] as string | null,
    };
  }
  async getDocument(id: string): Promise<LegDocRow | null> {
    const [r] = await this.db.query<R>(
      `SELECT d.id, d.type, d.official_number, d.adopted_at::text AS adopted_at, d.title, d.language, d.source_url, d.canonical_url,
              (SELECT max(version_no) FROM legislation_versions v WHERE v.document_id = d.id) AS latest_no,
              (SELECT valid_from::text FROM legislation_versions v WHERE v.document_id = d.id AND v.valid_to IS NULL LIMIT 1) AS current_from
         FROM legislation_documents d WHERE d.id = $1`,
      [id],
    );
    return r ? this.toDoc(r) : null;
  }
  async listVersions(documentId: string): Promise<LegVersionRow[]> {
    const rows = await this.db.query<R>(
      `SELECT ${VER} FROM legislation_versions WHERE document_id = $1 ORDER BY version_no DESC`,
      [documentId],
    );
    return rows.map(toVersion);
  }
  async getVersion(documentId: string, versionNo: number): Promise<LegVersionRow | null> {
    const [r] = await this.db.query<R>(
      `SELECT ${VER} FROM legislation_versions WHERE document_id = $1 AND version_no = $2`,
      [documentId, versionNo],
    );
    return r ? toVersion(r) : null;
  }
  /** Tarixdə qüvvədə olan versiya (RAG və sorğular üçün). */
  async versionOn(documentId: string, date: string): Promise<LegVersionRow | null> {
    const [r] = await this.db.query<R>(
      `SELECT ${VER} FROM legislation_versions WHERE document_id = $1 AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to >= $2::date)`,
      [documentId, date],
    );
    return r ? toVersion(r) : null;
  }

  // ------------------------------------------------------------- alerts
  async openAlert(kind: string, sourceId: string, message: string): Promise<boolean> {
    const rows = await this.db.query(
      `INSERT INTO system_alerts (kind, source_id, message) VALUES ($1,$2,$3) ON CONFLICT (kind, source_id) WHERE resolved_at IS NULL DO NOTHING RETURNING id`,
      [kind, sourceId, message],
    );
    return rows.length === 1;
  }
  async resolveAlert(kind: string, sourceId: string, now: Date): Promise<void> {
    await this.db.query(
      `UPDATE system_alerts SET resolved_at = $3 WHERE kind = $1 AND source_id = $2 AND resolved_at IS NULL`,
      [kind, sourceId, now],
    );
  }
  async openAlerts(): Promise<
    Array<{ id: string; kind: string; sourceId: string | null; message: string; createdAt: Date }>
  > {
    const rows = await this.db.query<R>(
      `SELECT id, kind, source_id, message, created_at FROM system_alerts WHERE resolved_at IS NULL ORDER BY created_at DESC`,
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      kind: r['kind'] as string,
      sourceId: r['source_id'] as string | null,
      message: r['message'] as string,
      createdAt: r['created_at'] as Date,
    }));
  }
}
