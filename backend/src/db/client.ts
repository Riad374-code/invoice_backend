import pg from 'pg';
import { mapDbError, mapTxError } from './errors.js';

export type Row = Record<string, unknown>;

/** Repository-lərin gördüyü minimal DB interfeysi (pg Pool və PGlite üçün eyni). */
export interface Db {
  query<R extends Row = Row>(text: string, params?: readonly unknown[]): Promise<R[]>;
  /** Parametrsiz, çox ifadəli SQL (migration-lar). */
  exec(sql: string): Promise<void>;
  /** Transaksiya. Daxili çağırış eyni transaksiyaya qoşulur. */
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** jsonb sütunlarına yazarkən: pg massivləri PG massivi kimi göndərir, ona görə həmişə stringify. */
export function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

class PgTx implements Db {
  constructor(private readonly client: pg.PoolClient) {}

  async query<R extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<R[]> {
    try {
      const res = await this.client.query(text, params as unknown[]);
      return res.rows as R[];
    } catch (err) {
      throw mapDbError(err);
    }
  }
  async exec(sql: string): Promise<void> {
    try {
      await this.client.query(sql);
    } catch (err) {
      throw mapDbError(err);
    }
  }
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return fn(this);
  }
  ping(): Promise<void> {
    return this.exec('SELECT 1');
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

export class PgDb implements Db {
  private constructor(private readonly pool: pg.Pool) {}

  static connect(databaseUrl: string, max = 20): PgDb {
    const pool = new pg.Pool({ connectionString: databaseUrl, max });
    // Boş client xətası prosesi çökdürməsin; sorğu səviyyəsində ayrıca xəta gələcək.
    pool.on('error', () => undefined);
    return new PgDb(pool);
  }

  async query<R extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<R[]> {
    try {
      const res = await this.pool.query(text, params as unknown[]);
      return res.rows as R[];
    } catch (err) {
      throw mapDbError(err);
    }
  }
  async exec(sql: string): Promise<void> {
    try {
      await this.pool.query(sql);
    } catch (err) {
      throw mapDbError(err);
    }
  }
  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgTx(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapTxError(err);
    } finally {
      client.release();
    }
  }
  ping(): Promise<void> {
    return this.exec('SELECT 1');
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}
