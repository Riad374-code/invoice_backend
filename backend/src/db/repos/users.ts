import type { User, UserStatus } from '../../domain/index.js';
import type { Db } from '../client.js';

interface UserRow {
  id: string;
  company_id: string;
  email: string;
  password_hash: string;
  status: UserStatus;
  mfa_secret: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  [k: string]: unknown;
}

const COLUMNS = `id, company_id, email, password_hash, status, mfa_secret,
  created_at, updated_at, deleted_at`;

const toUser = (r: UserRow): User => ({
  id: r.id,
  companyId: r.company_id,
  email: r.email,
  passwordHash: r.password_hash,
  status: r.status,
  mfaSecret: r.mfa_secret,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});

export class UserRepository {
  constructor(private readonly db: Db) {}

  /** E-poçt həmişə kiçik hərflə saxlanır (unikallıq qeydiyyatdan asılı olmasın). */
  async create(u: User): Promise<User> {
    const email = u.email.trim().toLowerCase();
    await this.db.query(
      `INSERT INTO users (id, company_id, email, password_hash, status, mfa_secret, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [u.id, u.companyId, email, u.passwordHash, u.status, u.mfaSecret, u.createdAt, u.updatedAt],
    );
    return { ...u, email };
  }

  async findById(id: string): Promise<User | null> {
    const [row] = await this.db.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return row ? toUser(row) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await this.db.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [email.trim().toLowerCase()],
    );
    return row ? toUser(row) : null;
  }

  async updateStatus(id: string, status: UserStatus, now: Date = new Date()): Promise<void> {
    await this.db.query(`UPDATE users SET status = $2, updated_at = $3 WHERE id = $1`, [
      id,
      status,
      now,
    ]);
  }
}
