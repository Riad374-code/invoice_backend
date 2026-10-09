import type { Approval, ApprovalStatus } from '../../domain/index.js';
import { toJson, type Db } from '../client.js';

interface ApprovalRow {
  id: string;
  company_id: string;
  kind: string;
  resource_ref: string;
  payload: unknown;
  requester_id: string;
  approver_id: string | null;
  status: ApprovalStatus;
  expires_at: Date;
  decided_at: Date | null;
  comment: string | null;
  created_at: Date;
  updated_at: Date;
  [k: string]: unknown;
}

const COLUMNS = `id, company_id, kind, resource_ref, payload, requester_id, approver_id, status,
  expires_at, decided_at, comment, created_at, updated_at`;

const toApproval = (r: ApprovalRow): Approval => ({
  id: r.id,
  companyId: r.company_id,
  kind: r.kind,
  resourceRef: r.resource_ref,
  payload: r.payload,
  requesterId: r.requester_id,
  approverId: r.approver_id,
  status: r.status,
  expiresAt: r.expires_at,
  decidedAt: r.decided_at,
  comment: r.comment,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class ApprovalRepository {
  constructor(private readonly db: Db) {}

  async create(a: Approval): Promise<Approval> {
    await this.db.query(
      `INSERT INTO approvals (id, company_id, kind, resource_ref, payload, requester_id, approver_id,
         status, expires_at, decided_at, comment, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        a.id,
        a.companyId,
        a.kind,
        a.resourceRef,
        toJson(a.payload ?? {}),
        a.requesterId,
        a.approverId,
        a.status,
        a.expiresAt,
        a.decidedAt,
        a.comment,
        a.createdAt,
        a.updatedAt,
      ],
    );
    return a;
  }

  /** `forUpdate` yalnız transaksiya daxilində mənalıdır (paralel qərar yarışını bloklayır). */
  async findById(id: string, opts: { forUpdate?: boolean } = {}): Promise<Approval | null> {
    const [row] = await this.db.query<ApprovalRow>(
      `SELECT ${COLUMNS} FROM approvals WHERE id = $1 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    return row ? toApproval(row) : null;
  }

  async listByCompany(companyId: string): Promise<Approval[]> {
    const rows = await this.db.query<ApprovalRow>(
      `SELECT ${COLUMNS} FROM approvals WHERE company_id = $1 ORDER BY created_at DESC, id DESC`,
      [companyId],
    );
    return rows.map(toApproval);
  }

  /** Qərarı (status/approver/decided_at/comment) yazır. */
  async saveDecision(a: Approval): Promise<void> {
    await this.db.query(
      `UPDATE approvals SET status = $2, approver_id = $3, decided_at = $4, comment = $5,
              updated_at = $6 WHERE id = $1`,
      [a.id, a.status, a.approverId, a.decidedAt, a.comment, a.updatedAt],
    );
  }
}
