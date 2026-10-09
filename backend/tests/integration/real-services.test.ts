import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDb, createRepos, migrate } from '../../src/db/index.js';
import { S3Storage } from '../../src/storage/index.js';

/**
 * Gerçək xidmətlərə qarşı testlər — yalnız CI-da (və ya lokal compose-da) TEST_* dəyişənləri
 * verildikdə işləyir; əks halda atlanır. Proses daxili PGlite/mock-lar bunları əvəz edə bilmir:
 *  - MinIO: checksum, path-style, 404 xəritələməsi
 *  - Postgres: `FOR UPDATE SKIP LOCKED` ilə həqiqətən paralel bağlantılar
 */
const dbUrl = process.env['TEST_DATABASE_URL'];
const s3Endpoint = process.env['TEST_S3_ENDPOINT'];

describe.skipIf(!dbUrl)('real PostgreSQL', () => {
  let db: PgDb;
  beforeAll(async () => {
    db = PgDb.connect(dbUrl!, 10);
    await migrate(db);
  });
  afterAll(() => db.close());

  it('parallel workers never claim the same job', async () => {
    const repos = createRepos(db);
    const queue = `real.claim.${randomUUID()}`;
    const total = 40;
    for (let i = 0; i < total; i++) await repos.jobs.enqueue({ queue, payload: { i } });

    const claimedBy = async (worker: string) => {
      const ids: string[] = [];
      for (;;) {
        const job = await repos.jobs.claim(worker, [queue], new Date());
        if (!job) return ids;
        ids.push(job.id);
      }
    };
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => claimedBy(`w${i}`)));
    const all = results.flat();
    expect(all).toHaveLength(total);
    expect(new Set(all).size).toBe(total);
    expect(results.filter((r) => r.length > 0).length).toBeGreaterThan(1); // iş həqiqətən bölüşdürüldü
  });

  it('migrations produced the Azerbaijani/RAG extensions and the immutable audit trigger', async () => {
    const ext = (await db.query<{ extname: string }>('SELECT extname FROM pg_extension')).map(
      (r) => r.extname,
    );
    expect(ext).toEqual(expect.arrayContaining(['vector', 'pg_trgm', 'unaccent']));
    const [{ n } = { n: 0 }] = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM pg_trigger WHERE tgname = 'trg_audit_events_immutable'`,
    );
    expect(n).toBe(1);
  });
});

describe.skipIf(!s3Endpoint)('real S3 (MinIO)', () => {
  const storage = new S3Storage({
    endpoint: s3Endpoint,
    region: 'eu-central-1',
    bucket: `lexaudit-test-${randomUUID().slice(0, 8)}`,
    accessKey: 'minioadmin',
    secretKey: 'minioadmin',
  });
  beforeAll(() => storage.ensureBucket());

  it('stores with checksum verification, reads back, streams, and reports missing keys', async () => {
    const body = Buffer.from('ƏDV qaiməsi\n'.repeat(1000));
    const sha256 = createHash('sha256').update(body).digest('hex');
    const key = `companies/test/blobs/${sha256.slice(0, 2)}/${sha256}`;

    expect(await storage.exists(key)).toBe(false);
    await storage.put(key, body, { contentType: 'text/plain', sha256 });
    expect(await storage.exists(key)).toBe(true);
    expect((await storage.get(key)).equals(body)).toBe(true);

    const chunks: Buffer[] = [];
    for await (const c of await storage.getStream(key)) chunks.push(Buffer.from(c as Uint8Array));
    expect(Buffer.concat(chunks).equals(body)).toBe(true);

    await expect(storage.get('does/not/exist')).rejects.toMatchObject({ kind: 'NOT_FOUND' });
    await storage.ping();
  });

  it('rejects an upload whose bytes do not match the declared SHA-256', async () => {
    const body = Buffer.from('tampered');
    const wrong = createHash('sha256').update('something else').digest('hex');
    await expect(
      storage.put('bad/checksum', body, { contentType: 'text/plain', sha256: wrong }),
    ).rejects.toMatchObject({
      kind: 'UNAVAILABLE',
    });
  });
});
