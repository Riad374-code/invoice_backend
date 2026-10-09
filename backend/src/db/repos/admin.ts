import { toJson, type Db } from '../client.js';

type R = Record<string, unknown>;
export type ModelStatus = 'candidate' | 'canary' | 'production' | 'retired';
export interface ModelRow {
  id: string;
  name: string;
  version: string;
  kind: 'llm' | 'embedding' | 'classifier';
  artifactUri: string;
  status: ModelStatus;
  evalReport: unknown;
  createdAt: Date;
}
const M = `id, name, version, kind, artifact_uri, status, eval_report, created_at`;
const toM = (r: R): ModelRow => ({
  id: r['id'] as string,
  name: r['name'] as string,
  version: r['version'] as string,
  kind: r['kind'] as ModelRow['kind'],
  artifactUri: r['artifact_uri'] as string,
  status: r['status'] as ModelStatus,
  evalReport: r['eval_report'],
  createdAt: r['created_at'] as Date,
});

export class AdminRepository {
  constructor(private readonly db: Db) {}

  // ------------------------------------------------------------ users / roles
  async listUsers(
    companyId: string,
  ): Promise<
    Array<{ id: string; email: string; status: string; roles: string[]; createdAt: Date }>
  > {
    const rows = await this.db.query<R>(
      `SELECT u.id, u.email, u.status, u.created_at, COALESCE(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
         FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
        WHERE u.company_id = $1 AND u.deleted_at IS NULL GROUP BY u.id ORDER BY u.email`,
      [companyId],
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      email: r['email'] as string,
      status: r['status'] as string,
      roles: r['roles'] as string[],
      createdAt: r['created_at'] as Date,
    }));
  }
  /** Rollar: sistem (company_id NULL) + şirkətin öz rolları, icazələri ilə. */
  async listRoles(companyId: string): Promise<
    Array<{
      id: string;
      name: string;
      system: boolean;
      description: string | null;
      permissions: string[];
    }>
  > {
    const rows = await this.db.query<R>(
      `SELECT r.id, r.name, r.company_id IS NULL AS system, r.description, COALESCE(array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS perms
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id LEFT JOIN permissions p ON p.id = rp.permission_id
        WHERE r.company_id IS NULL OR r.company_id = $1 GROUP BY r.id ORDER BY system DESC, r.name`,
      [companyId],
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      name: r['name'] as string,
      system: r['system'] as boolean,
      description: r['description'] as string | null,
      permissions: r['perms'] as string[],
    }));
  }
  async setUserRoles(userId: string, roleIds: string[]): Promise<void> {
    await this.db.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
    for (const id of roleIds)
      await this.db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [userId, id]);
  }
  async setRolePermissions(roleId: string, codes: string[]): Promise<void> {
    await this.db.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
    await this.db.query(
      `INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = ANY($2::text[])`,
      [roleId, codes],
    );
  }
  async knownPermissionCodes(): Promise<Set<string>> {
    return new Set(
      (await this.db.query<R>(`SELECT code FROM permissions`)).map((r) => r['code'] as string),
    );
  }
  /** Şirkətdə `admin` rolu olan AKTİV istifadəçilərin sayı (son admini itirməmək üçün). */
  async activeAdminCount(companyId: string, excludeUserId?: string): Promise<number> {
    const [r] = await this.db.query<R>(
      `SELECT count(DISTINCT u.id)::int AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
        WHERE u.company_id = $1 AND u.status = 'active' AND u.deleted_at IS NULL AND r.name = 'admin' AND r.company_id IS NULL AND ($2::uuid IS NULL OR u.id <> $2::uuid)`,
      [companyId, excludeUserId ?? null],
    );
    return r!['n'] as number;
  }

  // ------------------------------------------------------------- tax rates
  async allTaxRates(): Promise<
    Array<{
      id: string;
      taxType: string;
      code: string;
      rate: string;
      treatment: string | null;
      validFrom: string;
      validTo: string | null;
      legalSourceId: string | null;
      status: string;
    }>
  > {
    const rows = await this.db.query<R>(
      `SELECT id, tax_type, code, rate::text AS rate, treatment, valid_from::text AS vf, valid_to::text AS vt, legal_source_id, status FROM tax_rates ORDER BY tax_type, code, valid_from`,
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      taxType: r['tax_type'] as string,
      code: r['code'] as string,
      rate: r['rate'] as string,
      treatment: r['treatment'] as string | null,
      validFrom: r['vf'] as string,
      validTo: r['vt'] as string | null,
      legalSourceId: r['legal_source_id'] as string | null,
      status: r['status'] as string,
    }));
  }

  // ---------------------------------------------------------------- models
  async listModels(): Promise<ModelRow[]> {
    return (
      await this.db.query<R>(`SELECT ${M} FROM model_versions ORDER BY kind, created_at DESC`)
    ).map(toM);
  }
  async getModel(id: string, opts: { forUpdate?: boolean } = {}): Promise<ModelRow | null> {
    const [r] = await this.db.query<R>(
      `SELECT ${M} FROM model_versions WHERE id = $1 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    return r ? toM(r) : null;
  }
  async createModel(m: {
    name: string;
    version: string;
    kind: string;
    artifactUri: string;
    evalReport: unknown;
    userId: string;
  }): Promise<ModelRow> {
    const [r] = await this.db.query<R>(
      `INSERT INTO model_versions (name, version, kind, artifact_uri, eval_report, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING ${M}`,
      [m.name, m.version, m.kind, m.artifactUri, toJson(m.evalReport), m.userId],
    );
    return toM(r!);
  }
  async setModelStatus(id: string, status: ModelStatus): Promise<void> {
    await this.db.query(`UPDATE model_versions SET status = $2, updated_at = NOW() WHERE id = $1`, [
      id,
      status,
    ]);
  }
  async retireProduction(kind: string, exceptId: string): Promise<void> {
    await this.db.query(
      `UPDATE model_versions SET status = 'retired', updated_at = NOW() WHERE kind = $1 AND status = 'production' AND id <> $2`,
      [kind, exceptId],
    );
  }

  // -------------------------------------------------------------- feedback
  async unexportedFeedback(
    upTo: Date,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      kind: string;
      before: unknown;
      after: unknown;
      createdAt: Date;
      target: string;
    }>
  > {
    const rows = await this.db.query<R>(
      `SELECT id, kind, before, after, created_at, CASE WHEN message_id IS NOT NULL THEN 'message' WHEN invoice_line_id IS NOT NULL THEN 'invoice_line' ELSE 'journal_line' END AS target
         FROM feedback_events WHERE exported_at IS NULL AND created_at <= $1 ORDER BY created_at, id LIMIT $2`,
      [upTo, limit],
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      kind: r['kind'] as string,
      before: r['before'],
      after: r['after'],
      createdAt: r['created_at'] as Date,
      target: r['target'] as string,
    }));
  }
  async markExported(ids: string[], at: Date): Promise<void> {
    await this.db.query(`UPDATE feedback_events SET exported_at = $2 WHERE id = ANY($1::uuid[])`, [
      ids,
      at,
    ]);
  }
  async recordExport(e: {
    storageKey: string;
    sha256: string;
    rows: number;
    from: Date | null;
    to: Date;
  }): Promise<string> {
    const [r] = await this.db.query<{ id: string }>(
      `INSERT INTO feedback_exports (storage_key, sha256, rows, from_ts, to_ts) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [e.storageKey, e.sha256, e.rows, e.from, e.to],
    );
    return r!.id;
  }
}
