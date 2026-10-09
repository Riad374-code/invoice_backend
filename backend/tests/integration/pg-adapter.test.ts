import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDb, createRepos, migrate, type Repos } from '../../src/db/index.js';
import { newApproval, newAuditEvent } from '../../src/domain/index.js';

/**
 * `PgDb` (node-postgres) adapteri gerçək Postgres WIRE protokolu üzərindən yoxlanılır:
 * PGlite socket server-ə `pg.Pool` qoşulur → parametr serializasiyası (massiv, jsonb, Date),
 * SQLSTATE → DbError xəritələməsi və transaksiya semantikası sınanır.
 */
let server: PGLiteSocketServer;
let lite: PGlite;
let db: PgDb;
let repos: Repos;
let companyId: string;
let userId: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * pglite-socket bağlantını hər SQL xətasından sonra bağlayır (test aləti məhdudiyyəti, real Postgres belə etmir).
 * Gözlənilən xətadan sonra pool-un ölü bağlantını atmasına imkan veririk.
 */
const settle = () => sleep(60);

beforeAll(async () => {
  lite = new PGlite({ extensions: { vector, pg_trgm, unaccent, pgcrypto, uuid_ossp, btree_gist } });
  await lite.waitReady;
  server = new PGLiteSocketServer({ db: lite, port: 0, host: '127.0.0.1' });
  await server.start();
  const addr = (server as unknown as { server: { address(): { port: number } } }).server.address();
  db = PgDb.connect(
    `postgres://postgres:postgres@127.0.0.1:${addr.port}/postgres?sslmode=disable`,
    3,
  );
  await migrate(db);
  repos = createRepos(db);

  const now = new Date();
  companyId = randomUUID();
  await repos.companies.create({
    id: companyId,
    name: 'Wire MMC',
    voen: '2222222222',
    baseCurrency: 'AZN',
    isVatPayer: true,
    taxRegime: 'general',
    reportingStandard: 'MMUS',
    chartOfAccountsId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  userId = (
    await repos.users.create({
      id: randomUUID(),
      companyId,
      email: 'wire@test.az',
      passwordHash: 'x',
      status: 'active',
      mfaSecret: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })
  ).id;
});

afterAll(async () => {
  await db.close();
  await sleep(50);
  await server.stop();
  await sleep(50);
  await lite.close();
});

describe('PgDb over the Postgres wire protocol', () => {
  it('migrates a clean database and is idempotent', async () => {
    const again = await migrate(db);
    expect(again.applied).toEqual([]);
    expect(again.skipped.length).toBeGreaterThanOrEqual(3);
  });

  it('round-trips jsonb, timestamptz and text[] parameters', async () => {
    const event = newAuditEvent({
      companyId,
      actorId: userId,
      action: 'wire.test',
      resourceType: 'thing',
      resourceId: '1',
      before: [1, 2, { a: 'b' }], // JS massivi jsonb kimi getməlidir (PG massivi kimi yox)
      after: { nested: { ok: true } },
      requestId: 'req_wire',
    });
    await repos.audit.insert(event);
    const [stored] = await repos.audit.listByCompany(companyId, 1);
    expect(stored?.before).toEqual([1, 2, { a: 'b' }]);
    expect(stored?.after).toEqual({ nested: { ok: true } });
    expect(stored?.createdAt).toBeInstanceOf(Date);
    expect(Math.abs(stored!.createdAt.getTime() - event.createdAt.getTime())).toBeLessThan(1);

    const file = await repos.files.create({
      id: randomUUID(),
      companyId,
      name: 'wire.csv',
      mime: 'text/csv',
      size: 12,
      folder: '/',
      tags: ['ədv', 'q1'],
      ownerId: userId,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const loaded = await repos.files.findById(companyId, file.id);
    expect(loaded?.tags).toEqual(['ədv', 'q1']);
    expect(typeof loaded?.size).toBe('number'); // BIGINT → number

    const byTag = await repos.files.list({ companyId, tag: 'ədv', limit: 10 });
    expect(byTag.map((f) => f.id)).toContain(file.id);
  });

  it('maps SQLSTATEs to DbError kinds', async () => {
    await expect(
      repos.companies.create({
        id: randomUUID(),
        name: 'dup',
        voen: '2222222222',
        baseCurrency: 'AZN',
        isVatPayer: true,
        taxRegime: 'general',
        reportingStandard: 'MMUS',
        chartOfAccountsId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      }),
    ).rejects.toMatchObject({ kind: 'CONFLICT' });
    await settle();

    const a = await repos.approvals.create(
      newApproval({
        companyId,
        kind: 'k',
        resourceRef: 'r',
        payload: {},
        requesterId: userId,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    await expect(
      repos.approvals.saveDecision({
        ...a,
        status: 'approved',
        approverId: userId,
        decidedAt: new Date(),
      }),
    ).rejects.toMatchObject({ kind: 'CONSTRAINT' });
    await settle();

    const [evt] = await repos.audit.listByCompany(companyId, 1);
    await expect(
      db.query('DELETE FROM audit_events WHERE id = $1', [evt!.id]),
    ).rejects.toMatchObject({
      kind: 'IMMUTABILITY',
    });
    await settle();
    await expect(db.query('SELECT * FROM table_that_does_not_exist')).rejects.toMatchObject({
      kind: 'INTERNAL',
    });
    await settle();
  });

  it('transactions commit, roll back, and let application errors through untouched', async () => {
    class AppError extends Error {
      code = 'FORBIDDEN';
    }
    await expect(
      db.tx(async (tx) => {
        await tx.query(`INSERT INTO permissions (code) VALUES ('wire:tx')`);
        throw new AppError('nope');
      }),
    ).rejects.toBeInstanceOf(AppError);
    await settle();
    expect(await db.query(`SELECT 1 FROM permissions WHERE code = 'wire:tx'`)).toHaveLength(0);

    await db.tx(async (tx) => {
      await tx.query(`INSERT INTO permissions (code) VALUES ('wire:tx')`);
      // iç-içə tx eyni transaksiyaya qoşulur
      await tx.tx((inner) => inner.query(`INSERT INTO permissions (code) VALUES ('wire:tx2')`));
    });
    expect(
      await db.query(`SELECT 1 FROM permissions WHERE code IN ('wire:tx','wire:tx2')`),
    ).toHaveLength(2);

    // DB xətası tx içində → DbError, tam rollback
    await expect(
      db.tx(async (tx) => {
        await tx.query(`INSERT INTO permissions (code) VALUES ('wire:tx3')`);
        await tx.query(`INSERT INTO permissions (code) VALUES ('wire:tx')`); // unique pozuntusu
      }),
    ).rejects.toMatchObject({ kind: 'CONFLICT' });
    await settle();
    expect(await db.query(`SELECT 1 FROM permissions WHERE code = 'wire:tx3'`)).toHaveLength(0);
  });

  it('job queue claim works through the wire protocol (FOR UPDATE SKIP LOCKED + text[] ANY)', async () => {
    await repos.jobs.enqueue({ queue: 'wire.q', payload: { n: 1 } });
    const claimed = await repos.jobs.claim('w', ['wire.q', 'other'], new Date());
    expect(claimed).toMatchObject({ queue: 'wire.q', status: 'running', payload: { n: 1 } });
    expect(await repos.jobs.claim('w', ['wire.q'], new Date())).toBeNull();
  });

  it('ping works and uuid[] ANY filters parameterise correctly', async () => {
    await db.ping();
    expect((await repos.files.latestExtractionStatuses(companyId, [randomUUID()])).size).toBe(0);
  });
});
