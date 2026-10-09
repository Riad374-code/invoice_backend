import type { Session } from '../../domain/index.js';
import type { Db } from '../client.js';

interface SessionRow {
  id: string;
  company_id: string;
  user_id: string;
  refresh_token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
  updated_at: Date;
  [k: string]: unknown;
}

const COLUMNS = `id, company_id, user_id, refresh_token_hash, expires_at, revoked_at, ip,
  user_agent, created_at, updated_at`;

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  companyId: r.company_id,
  userId: r.user_id,
  refreshTokenHash: r.refresh_token_hash,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  ip: r.ip,
  userAgent: r.user_agent,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class SessionRepository {
  constructor(private readonly db: Db) {}

  async create(s: Session): Promise<Session> {
    await this.db.query(
      `INSERT INTO sessions (id, company_id, user_id, refresh_token_hash, expires_at, revoked_at,
         ip, user_agent, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        s.id,
        s.companyId,
        s.userId,
        s.refreshTokenHash,
        s.expiresAt,
        s.revokedAt,
        s.ip,
        s.userAgent,
        s.createdAt,
        s.updatedAt,
      ],
    );
    return s;
  }

  /** Statusundan asılı olmayaraq (reuse aşkarlaması üçün revoke olunmuşlar da qayıdır). */
  async findByHash(hash: string): Promise<Session | null> {
    const [row] = await this.db.query<SessionRow>(
      `SELECT ${COLUMNS} FROM sessions WHERE refresh_token_hash = $1`,
      [hash],
    );
    return row ? toSession(row) : null;
  }

  async findActiveByHash(hash: string, now: Date): Promise<Session | null> {
    const [row] = await this.db.query<SessionRow>(
      `SELECT ${COLUMNS} FROM sessions
        WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [hash, now],
    );
    return row ? toSession(row) : null;
  }

  /**
   * Atomik revoke: yalnız hələ aktiv sessiya üçün true qaytarır. Eyni refresh token-in
   * paralel iki istifadəsində yalnız biri uğur qazanır (rotation race).
   */
  async revoke(id: string, now: Date): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE sessions SET revoked_at = $2, updated_at = $2
        WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
      [id, now],
    );
    return rows.length === 1;
  }

  async revokeAllForUser(userId: string, now: Date): Promise<number> {
    const rows = await this.db.query(
      `UPDATE sessions SET revoked_at = $2, updated_at = $2
        WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
      [userId, now],
    );
    return rows.length;
  }
}
