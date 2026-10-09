import { toJson, type Db } from '../client.js';

type R = Record<string, unknown>;

export interface FindingRow {
  id: string;
  sourceKind: 'news' | 'legislation_version';
  sourceId: string;
  affectedResourceType: 'file' | 'audit';
  affectedResourceId: string;
  score: string;
  explanation: string;
  evidence: unknown;
  status: 'new' | 'seen' | 'dismissed' | 'actioned';
  createdAt: Date;
}
export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  refType: string | null;
  refId: string | null;
  readAt: Date | null;
  createdAt: Date;
  seq: string;
}

const F = `id, source_kind, source_id, affected_resource_type, affected_resource_id, score::text AS score, explanation, evidence, status, created_at`;
const toF = (r: R): FindingRow => ({
  id: r['id'] as string,
  sourceKind: r['source_kind'] as FindingRow['sourceKind'],
  sourceId: r['source_id'] as string,
  affectedResourceType: r['affected_resource_type'] as FindingRow['affectedResourceType'],
  affectedResourceId: r['affected_resource_id'] as string,
  score: r['score'] as string,
  explanation: r['explanation'] as string,
  evidence: r['evidence'],
  status: r['status'] as FindingRow['status'],
  createdAt: r['created_at'] as Date,
});
const N = `id, kind, title, body, ref_type, ref_id, read_at, created_at, seq::text AS seq`;
const toN = (r: R): NotificationRow => ({
  id: r['id'] as string,
  kind: r['kind'] as string,
  title: r['title'] as string,
  body: r['body'] as string | null,
  refType: r['ref_type'] as string | null,
  refId: r['ref_id'] as string | null,
  readAt: r['read_at'] as Date | null,
  createdAt: r['created_at'] as Date,
  seq: r['seq'] as string,
});

export class ImpactRepository {
  constructor(private readonly db: Db) {}

  /** Mənbənin parçaları (xəbər / qanun versiyası) — embedding mətn kimi (pgvector literalı). */
  async sourceChunks(
    kind: FindingRow['sourceKind'],
    id: string,
  ): Promise<Array<{ id: string; text: string; embedding: string | null }>> {
    const rows = await this.db.query<R>(
      kind === 'news'
        ? `SELECT id, text, embedding::text AS embedding FROM chunks WHERE resource_type = 'news' AND resource_id = $1 ORDER BY chunk_no`
        : `SELECT id, text, embedding::text AS embedding FROM chunks WHERE resource_type = 'legislation' AND version_id = $1 ORDER BY chunk_no`,
      [id],
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      text: r['text'] as string,
      embedding: r['embedding'] as string | null,
    }));
  }
  async companiesWithFileChunks(): Promise<string[]> {
    const rows = await this.db.query<R>(
      `SELECT DISTINCT company_id FROM chunks WHERE resource_type = 'file' AND embedding IS NOT NULL`,
    );
    return rows.map((r) => r['company_id'] as string);
  }
  async nearestCompanyChunks(
    companyId: string,
    embedding: string,
    model: string,
    minSimilarity: number,
    limit: number,
  ): Promise<Array<{ chunkId: string; resourceId: string; text: string; similarity: number }>> {
    const rows = await this.db.query<R>(
      `SELECT id, resource_id, text, (1 - (embedding <=> $2::vector))::float8 AS sim FROM chunks
        WHERE company_id = $1 AND resource_type = 'file' AND embedding IS NOT NULL AND embedding_model = $3
          AND (1 - (embedding <=> $2::vector)) >= $4
        ORDER BY embedding <=> $2::vector, id LIMIT $5`,
      [companyId, embedding, model, minSimilarity, limit],
    );
    return rows.map((r) => ({
      chunkId: r['id'] as string,
      resourceId: r['resource_id'] as string,
      text: r['text'] as string,
      similarity: Number(r['sim']),
    }));
  }
  async upsertFinding(f: {
    companyId: string;
    sourceKind: string;
    sourceId: string;
    resourceId: string;
    score: string;
    explanation: string;
    evidence: unknown;
  }): Promise<{ id: string; created: boolean }> {
    const [r] = await this.db.query<R>(
      `INSERT INTO impact_findings (company_id, source_kind, source_id, affected_resource_type, affected_resource_id, score, explanation, evidence)
       VALUES ($1,$2,$3,'file',$4,$5::numeric,$6,$7::jsonb)
       ON CONFLICT (company_id, source_kind, source_id, affected_resource_type, affected_resource_id)
       DO UPDATE SET score = GREATEST(impact_findings.score, EXCLUDED.score), explanation = EXCLUDED.explanation, evidence = EXCLUDED.evidence, updated_at = NOW()
       RETURNING id, (xmax = 0) AS created`,
      [
        f.companyId,
        f.sourceKind,
        f.sourceId,
        f.resourceId,
        f.score,
        f.explanation,
        toJson(f.evidence),
      ],
    );
    return { id: r!['id'] as string, created: r!['created'] as boolean };
  }
  async listFindings(
    companyId: string,
    f: { status?: string | undefined; limit: number },
  ): Promise<FindingRow[]> {
    const rows = await this.db.query<R>(
      `SELECT ${F} FROM impact_findings WHERE company_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY score DESC, created_at DESC, id LIMIT $3`,
      [companyId, f.status ?? null, f.limit],
    );
    return rows.map(toF);
  }
  async setFindingStatus(
    companyId: string,
    id: string,
    status: string,
  ): Promise<FindingRow | null> {
    const [r] = await this.db.query<R>(
      `UPDATE impact_findings SET status = $3, updated_at = NOW() WHERE id = $1 AND company_id = $2 RETURNING ${F}`,
      [id, companyId, status],
    );
    return r ? toF(r) : null;
  }

  // ---------------------------------------------------------- notifications
  async usersWithPermission(companyId: string, permission: string): Promise<string[]> {
    const rows = await this.db.query<R>(
      `SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions p ON p.id = rp.permission_id
        WHERE u.company_id = $1 AND u.status = 'active' AND u.deleted_at IS NULL AND p.code = $2`,
      [companyId, permission],
    );
    return rows.map((r) => r['id'] as string);
  }
  async notify(n: {
    companyId: string;
    userId: string;
    kind: string;
    title: string;
    body: string | null;
    refType: string | null;
    refId: string | null;
  }): Promise<boolean> {
    const rows = await this.db.query(
      `INSERT INTO notifications (company_id, user_id, kind, title, body, ref_type, ref_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id, kind, ref_id) WHERE ref_id IS NOT NULL DO NOTHING RETURNING id`,
      [n.companyId, n.userId, n.kind, n.title, n.body, n.refType, n.refId],
    );
    return rows.length === 1;
  }
  async listNotifications(
    userId: string,
    f: { unreadOnly: boolean; limit: number; afterSeq?: string | undefined },
  ): Promise<NotificationRow[]> {
    const rows = await this.db.query<R>(
      `SELECT ${N} FROM notifications WHERE user_id = $1 AND ($2::boolean IS FALSE OR read_at IS NULL) AND ($3::bigint IS NULL OR seq > $3::bigint) ORDER BY seq DESC LIMIT $4`,
      [userId, f.unreadOnly, f.afterSeq ?? null, f.limit],
    );
    return rows.map(toN);
  }
  async unreadCount(userId: string): Promise<number> {
    const [r] = await this.db.query<R>(
      `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );
    return r!['n'] as number;
  }
  async markRead(userId: string, id: string | null, now: Date): Promise<number> {
    const rows = await this.db.query(
      `UPDATE notifications SET read_at = $3 WHERE user_id = $1 AND read_at IS NULL AND ($2::uuid IS NULL OR id = $2::uuid) RETURNING id`,
      [userId, id, now],
    );
    return rows.length;
  }

  // ----------------------------------------------------------- platform / rates
  async platformCompanyId(): Promise<string | null> {
    const [r] = await this.db.query<R>(
      `SELECT id FROM companies WHERE is_platform AND deleted_at IS NULL`,
    );
    return (r?.['id'] as string | undefined) ?? null;
  }
  /** Qeyri-interaktiv sistem istifadəçisi (login mümkün deyil: status suspended + keçərsiz hash). */
  async ensureSystemUser(companyId: string): Promise<string> {
    const [r] = await this.db.query<R>(
      `INSERT INTO users (company_id, email, password_hash, status) VALUES ($1, 'system@platform.invalid', '!disabled', 'suspended')
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      [companyId],
    );
    return r!['id'] as string;
  }
  async rateExists(taxType: string, code: string, validFrom: string): Promise<boolean> {
    return (
      (
        await this.db.query(
          `SELECT 1 FROM tax_rates WHERE tax_type = $1 AND code = $2 AND valid_from = $3::date`,
          [taxType, code, validFrom],
        )
      ).length > 0
    );
  }
  async findRate(id: string): Promise<{
    id: string;
    taxType: string;
    code: string;
    validFrom: string;
    status: string;
  } | null> {
    const [r] = await this.db.query<R>(
      `SELECT id, tax_type, code, valid_from::text AS vf, status FROM tax_rates WHERE id = $1`,
      [id],
    );
    return r
      ? {
          id: r['id'] as string,
          taxType: r['tax_type'] as string,
          code: r['code'] as string,
          validFrom: r['vf'] as string,
          status: r['status'] as string,
        }
      : null;
  }
  /** Əvvəlki açıq dövrü yeni dərəcənin başlanğıcından 1 gün əvvələ bağlayıb yenisini aktivləşdirir. */
  async activateRate(id: string): Promise<void> {
    const rate = await this.findRate(id);
    if (!rate || rate.status !== 'proposed') throw new Error('Rate is not a proposal');
    await this.db.query(
      `UPDATE tax_rates SET valid_to = ($3::date - 1), updated_at = NOW() WHERE tax_type = $1 AND code = $2 AND status = 'active' AND valid_to IS NULL AND valid_from < $3::date`,
      [rate.taxType, rate.code, rate.validFrom],
    );
    await this.db.query(
      `UPDATE tax_rates SET status = 'active', updated_at = NOW() WHERE id = $1`,
      [id],
    );
  }
  async deleteProposedRate(id: string): Promise<void> {
    await this.db.query(`DELETE FROM tax_rates WHERE id = $1 AND status = 'proposed'`, [id]);
  }
  async setNewsAi(
    id: string,
    a: { summary: string; category: string; riskLevel: string; tags: string[]; model: string },
  ): Promise<void> {
    await this.db.query(
      `UPDATE news_items SET ai_summary = $2, ai_category = $3, ai_risk_level = $4, ai_tags = $5::text[], ai_model_version = $6 WHERE id = $1`,
      [id, a.summary, a.category, a.riskLevel, a.tags, a.model],
    );
  }
  async newsForEnrichment(
    id: string,
  ): Promise<{ title: string; rawText: string; aiModel: string | null } | null> {
    const [r] = await this.db.query<R>(
      `SELECT title, raw_text, ai_model_version FROM news_items WHERE id = $1`,
      [id],
    );
    return r
      ? {
          title: r['title'] as string,
          rawText: r['raw_text'] as string,
          aiModel: r['ai_model_version'] as string | null,
        }
      : null;
  }
}
