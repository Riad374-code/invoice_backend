import { PGlite, type Transaction } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import type { Db, Row } from './client.js';
import { mapDbError, mapTxError } from './errors.js';

type Queryable = Pick<PGlite | Transaction, 'query' | 'exec'>;

/**
 * Proses daxili real Postgres (WASM) — testlər və Docker-siz lokal dev üçün.
 * Production-da İSTİFADƏ OLUNMUR (bax: main.ts).
 */
export class PgliteDb implements Db {
  private constructor(
    private readonly q: Queryable,
    private readonly root: PGlite | null,
  ) {}

  static async create(): Promise<PgliteDb> {
    const pg = new PGlite({
      extensions: { vector, pg_trgm, unaccent, pgcrypto, uuid_ossp, btree_gist },
    });
    await pg.waitReady;
    return new PgliteDb(pg, pg);
  }

  async query<R extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<R[]> {
    try {
      const res = await this.q.query<R>(text, params as unknown[]);
      return res.rows;
    } catch (err) {
      throw mapDbError(err);
    }
  }
  async exec(sql: string): Promise<void> {
    try {
      await this.q.exec(sql);
    } catch (err) {
      throw mapDbError(err);
    }
  }
  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (!this.root) return fn(this); // artıq transaksiyadayıq
    try {
      return await this.root.transaction((t) => fn(new PgliteDb(t, null)));
    } catch (err) {
      throw mapTxError(err);
    }
  }
  ping(): Promise<void> {
    return this.exec('SELECT 1');
  }
  async close(): Promise<void> {
    await this.root?.close();
  }
}
