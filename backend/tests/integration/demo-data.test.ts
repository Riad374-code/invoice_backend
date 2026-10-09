import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { PgliteDb, createRepos, migrate, type Db } from '../../src/db/index.js';
import { DEMO_VOEN, seedDemoData } from '../../src/demo-data.js';
import { verifyPassword } from '../../src/security/index.js';

let db: Db;
beforeAll(async () => {
  db = await PgliteDb.create();
  await migrate(db);
});
afterAll(() => db.close());

describe('demo seed', () => {
  it('requires an explicit strong password (no default credentials)', () => {
    const base = {
      JWT_SECRET: 'a'.repeat(40),
      CSRF_SECRET: 'b'.repeat(40),
      SEED_DEMO_DATA: 'true',
    };
    expect(() => loadConfig(base)).toThrow(/DEMO_PASSWORD/);
    expect(loadConfig({ ...base, DEMO_PASSWORD: 'x'.repeat(12) }).demoSeed).toBeDefined();
    expect(
      loadConfig({ JWT_SECRET: base.JWT_SECRET, CSRF_SECRET: base.CSRF_SECRET }).demoSeed,
    ).toBeUndefined();
  });

  it('is idempotent, isolated in its own company, and leaves real onboarding untouched', async () => {
    const repos = createRepos(db);
    const first = await seedDemoData(db, { password: 'Demo-Passw0rd-123' });
    expect(first).toMatchObject({ created: true, ratesCreated: 3 });
    expect((await seedDemoData(db, { password: 'Demo-Passw0rd-123' })).created).toBe(false);

    const demo = (await repos.companies.findByVoen(DEMO_VOEN))!;
    const invoices = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM invoices WHERE company_id = $1`,
      [demo.id],
    );
    expect(invoices[0]!.n).toBe(6);
    const admin = (await repos.users.findByEmail('admin@demo.lexaudit.local'))!;
    expect(await verifyPassword('Demo-Passw0rd-123', admin.passwordHash)).toBe(true);
    // jurnal təklifləri yaranıb, amma heç biri post olunmayıb
    const posted = await db.query(
      `SELECT 1 FROM journal_entries WHERE company_id = $1 AND status = 'posted'`,
      [demo.id],
    );
    expect(posted).toHaveLength(0);
    const proposed = await db.query(
      `SELECT 1 FROM journal_entries WHERE company_id = $1 AND status = 'proposed'`,
      [demo.id],
    );
    expect(proposed.length).toBeGreaterThan(0);

    // real şirkət eyni bazada sərbəst yaradıla və öz məlumatını yaza bilir
    const real = await repos.companies.create({
      id: crypto.randomUUID(),
      name: 'Real MMC',
      voen: '1234567890',
      baseCurrency: 'AZN',
      isVatPayer: true,
      taxRegime: 'general',
      reportingStandard: 'MMUS',
      chartOfAccountsId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    const cp = await repos.invoices.upsertCounterparty(real.id, {
      name: 'X',
      voen: '7654321098',
      isVatPayer: true,
    });
    expect(cp).toBeTruthy();
    const scoped = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM invoices WHERE company_id = $1`,
      [real.id],
    );
    expect(scoped[0]!.n).toBe(0);
  });
});
