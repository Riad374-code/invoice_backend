import type { AuditEvent } from '../../domain/index.js';
import { toJson, type Db } from '../client.js';

interface AuditRow {
  id: string;
  company_id: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  before: unknown;
  after: unknown;
  request_id: string;
  created_at: Date;
  [k: string]: unknown;
}

const toEvent = (r: AuditRow): AuditEvent => ({
  id: r.id,
  companyId: r.company_id,
  actorId: r.actor_id,
  action: r.action,
  resourceType: r.resource_type,
  resourceId: r.resource_id,
  before: r.before,
  after: r.after,
  requestId: r.request_id,
  createdAt: r.created_at,
});

/** audit_events yalnız INSERT — burada UPDATE/DELETE metodu yoxdur (və DB trigger-i də qadağan edir). */
export class AuditRepository {
  constructor(private readonly db: Db) {}

  async insert(e: AuditEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_events (id, company_id, actor_id, action, resource_type, resource_id,
         before, after, request_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
      [
        e.id,
        e.companyId,
        e.actorId,
        e.action,
        e.resourceType,
        e.resourceId,
        toJson(e.before),
        toJson(e.after),
        e.requestId,
        e.createdAt,
      ],
    );
  }

  async listByCompany(companyId: string, limit: number): Promise<AuditEvent[]> {
    const rows = await this.db.query<AuditRow>(
      `SELECT id, company_id, actor_id, action, resource_type, resource_id, before, after,
              request_id, created_at
         FROM audit_events WHERE company_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [companyId, limit],
    );
    return rows.map(toEvent);
  }
}
