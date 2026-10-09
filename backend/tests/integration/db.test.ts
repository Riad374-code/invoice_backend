import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DbError,
  PgliteDb,
  createRepos,
  migrate,
  type Db,
  type Repos,
} from '../../src/db/index.js';
import { newApproval, newAuditEvent } from '../../src/domain/index.js';

let db: Db;
let repos: Repos;
let companyId: string;
let userA: string;
let userB: string;

async function mkUser(email: string): Promise<string> {
  const now = new Date();
  const u = await repos.users.create({
    id: randomUUID(),
    companyId,
    email,
    passwordHash: 'x',
    status: 'active',
    mfaSecret: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  return u.id;
}

beforeAll(async () => {
  db = await PgliteDb.create();
  await migrate(db);
  repos = createRepos(db);
  const now = new Date();
  companyId = randomUUID();
  await repos.companies.create({
    id: companyId,
    name: 'DB Test MMC',
    voen: '1111111111',
    baseCurrency: 'AZN',
    isVatPayer: true,
    taxRegime: 'general',
    reportingStandard: 'MMUS',
    chartOfAccountsId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  userA = await mkUser('a@test.az');
  userB = await mkUser('b@test.az');
});
afterAll(() => db.close());

describe('migrations', () => {
  it('apply on a clean database, are idempotent, and seed RBAC', async () => {
    const fresh = await PgliteDb.create();
    const first = await migrate(fresh);
    expect(first.applied).toEqual([
      '0001_init.sql',
      '0002_seed_rbac.sql',
      '0003_files_jobs.sql',
      '0004_tax_rates.sql',
      '0005_invoices.sql',
      '0006_ingestion.sql',
      '0007_chunks.sql',
      '0008_assistant.sql',
      '0009_extraction.sql',
      '0010_message_order.sql',
      '0011_vat_ledger.sql',
      '0012_excel_recon_import.sql',
      '0013_impact.sql',
      '0014_feedback_models_admin.sql',
    ]);
    const second = await migrate(fresh);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toHaveLength(14);
    const [row] = await fresh.query<{ n: number }>('SELECT count(*)::int AS n FROM permissions');
    expect(row?.n).toBe(24);
    await fresh.close();
  });

  it('refuses a modified, already-applied migration', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
    await writeFile(path.join(dir, '0001_a.sql'), 'CREATE TABLE t1 (id int);');
    const scratch = await PgliteDb.create();
    await migrate(scratch, dir);
    await writeFile(path.join(dir, '0001_a.sql'), 'CREATE TABLE t1 (id int, extra int);');
    await expect(migrate(scratch, dir)).rejects.toThrow(/modified after being applied/);
    await scratch.close();
  });

  it('rolls a failing migration back completely', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
    await writeFile(
      path.join(dir, '0001_bad.sql'),
      'CREATE TABLE ok_t (id int); SELECT nope FROM missing;',
    );
    const scratch = await PgliteDb.create();
    await expect(migrate(scratch, dir)).rejects.toBeInstanceOf(DbError);
    const rows = await scratch.query("SELECT to_regclass('ok_t') AS t");
    expect(rows[0]?.['t']).toBeNull();
    await scratch.close();
  });

  it('enables the Azerbaijani/RAG extensions', async () => {
    const rows = await db.query<{ extname: string }>('SELECT extname FROM pg_extension');
    const names = rows.map((r) => r.extname);
    expect(names).toEqual(expect.arrayContaining(['vector', 'pg_trgm', 'unaccent']));
  });
});

describe('audit_events is append-only at DB level (§4.1)', () => {
  it('accepts INSERT but rejects UPDATE and DELETE', async () => {
    const event = newAuditEvent({
      companyId,
      actorId: userA,
      action: 'test.insert',
      resourceType: 'thing',
      resourceId: '1',
      before: null,
      after: { a: 1 },
      requestId: 'req_db',
    });
    await repos.audit.insert(event);
    const listed = await repos.audit.listByCompany(companyId, 10);
    expect(listed.map((e) => e.id)).toContain(event.id);

    await expect(
      db.query(`UPDATE audit_events SET action = 'x' WHERE id = $1`, [event.id]),
    ).rejects.toMatchObject({
      kind: 'IMMUTABILITY',
    });
    await expect(
      db.query(`DELETE FROM audit_events WHERE id = $1`, [event.id]),
    ).rejects.toMatchObject({
      kind: 'IMMUTABILITY',
    });
    const [row] = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM audit_events WHERE id = $1`,
      [event.id],
    );
    expect(row?.n).toBe(1);
  });
});

describe('approvals constraints (A-03)', () => {
  const base = () =>
    newApproval({
      companyId,
      kind: 'journal_post',
      resourceRef: 'journal:1',
      payload: { x: 1 },
      requesterId: userA,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

  it('CHECK rejects approver_id = requester_id', async () => {
    const a = await repos.approvals.create(base());
    await expect(
      repos.approvals.saveDecision({
        ...a,
        status: 'approved',
        approverId: userA,
        decidedAt: new Date(),
      }),
    ).rejects.toMatchObject({ kind: 'CONSTRAINT' });
  });

  it('accepts a different approver and round-trips jsonb', async () => {
    const a = await repos.approvals.create(base());
    await repos.approvals.saveDecision({
      ...a,
      status: 'approved',
      approverId: userB,
      decidedAt: new Date(),
      comment: 'ok',
    });
    const found = await repos.approvals.findById(a.id);
    expect(found).toMatchObject({
      status: 'approved',
      approverId: userB,
      comment: 'ok',
      payload: { x: 1 },
    });
  });

  it('rejects an invalid status value', async () => {
    const a = await repos.approvals.create(base());
    await expect(
      db.query(`UPDATE approvals SET status = 'bogus' WHERE id = $1`, [a.id]),
    ).rejects.toMatchObject({
      kind: 'CONSTRAINT',
    });
  });
});

describe('repositories', () => {
  it('stores e-mails lower-cased and enforces uniqueness', async () => {
    const now = new Date();
    await expect(
      repos.users.create({
        id: randomUUID(),
        companyId,
        email: ' A@TEST.az ',
        passwordHash: 'x',
        status: 'active',
        mfaSecret: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }),
    ).rejects.toMatchObject({ kind: 'CONFLICT' });
    expect((await repos.users.findByEmail('A@Test.AZ'))?.id).toBe(userA);
  });

  it('rejects duplicate VÖEN', async () => {
    const now = new Date();
    await expect(
      repos.companies.create({
        id: randomUUID(),
        name: 'Dup',
        voen: '1111111111',
        baseCurrency: 'AZN',
        isVatPayer: true,
        taxRegime: 'general',
        reportingStandard: 'MMUS',
        chartOfAccountsId: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }),
    ).rejects.toMatchObject({ kind: 'CONFLICT' });
  });

  it('resolves permissions through roles', async () => {
    const viewer = await repos.roles.findRoleByName('viewer');
    await repos.roles.assignRoleToUser(userA, viewer!.id);
    const perms = (await repos.roles.getUserPermissions(userA)).map((p) => p.code);
    expect(perms).toEqual([
      'assistant:use',
      'files:read',
      'impact:read',
      'invoices:read',
      'journal:read',
      'legislation:read',
      'news:read',
      'vat:read',
    ]);
    expect((await repos.roles.getUserRoles(userA)).map((r) => r.name)).toEqual(['viewer']);
  });

  it('revokes a session atomically exactly once', async () => {
    const now = new Date();
    const s = await repos.sessions.create({
      id: randomUUID(),
      companyId,
      userId: userA,
      refreshTokenHash: 'hash-' + randomUUID(),
      expiresAt: new Date(now.getTime() + 60_000),
      revokedAt: null,
      ip: '127.0.0.1',
      userAgent: 'vitest',
      createdAt: now,
      updatedAt: now,
    });
    expect(await repos.sessions.findActiveByHash(s.refreshTokenHash, now)).not.toBeNull();
    expect(await repos.sessions.revoke(s.id, now)).toBe(true);
    expect(await repos.sessions.revoke(s.id, now)).toBe(false);
    expect(await repos.sessions.findActiveByHash(s.refreshTokenHash, now)).toBeNull();
    expect((await repos.sessions.findByHash(s.refreshTokenHash))?.revokedAt).not.toBeNull();
  });

  it('transactions commit and roll back', async () => {
    const id = randomUUID();
    await expect(
      db.tx(async (tx) => {
        await tx.query(`INSERT INTO permissions (id, code) VALUES ($1, 'tx:test')`, [id]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.query(`SELECT 1 FROM permissions WHERE code = 'tx:test'`)).toHaveLength(0);
    await db.tx((tx) =>
      tx.query(`INSERT INTO permissions (id, code) VALUES ($1, 'tx:test')`, [id]),
    );
    expect(await db.query(`SELECT 1 FROM permissions WHERE code = 'tx:test'`)).toHaveLength(1);
  });
});
