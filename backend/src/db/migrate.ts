import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Db } from './client.js';

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const LOCK_KEY = 7_204_001; // ixtiyari sabit: paralel migrate-lər növbələnsin

/**
 * `migrations/*.sql` fayllarını ad sırası ilə tətbiq edir (yalnız irəli).
 * Tətbiq olunmuş faylın dəyişdirilməsi checksum ilə aşkarlanır və xəta verir.
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const result: MigrationResult = { applied: [], skipped: [] };

  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');

    await db.tx(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const [existing] = await tx.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [file],
      );
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(
            `Migration ${file} was modified after being applied (checksum mismatch). Add a new migration instead.`,
          );
        }
        result.skipped.push(file);
        return;
      }
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
        file,
        checksum,
      ]);
      result.applied.push(file);
    });
  }
  return result;
}
