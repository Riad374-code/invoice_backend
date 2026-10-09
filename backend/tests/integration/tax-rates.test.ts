import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  D,
  formatAmount,
  taxRate,
  vat,
  withholding,
  type TaxRate,
} from '../../src/accounting/index.js';
import { seedDevTaxRates } from '../../src/bootstrap.js';
import { createTestEnv, type TestEnv } from '../helpers/app.js';

let env: TestEnv;
let adminToken: string;
let viewerToken: string;

type RateInput = Omit<Parameters<typeof taxRate>[0], 'id'> & { id?: string };
const insert = (r: RateInput) =>
  env.repos.taxRates.create(taxRate({ ...r, id: r.id ?? randomUUID() }));

let LEGAL_SRC = '';
beforeAll(async () => {
  env = await createTestEnv({ loginRateLimitPerMinute: 1000 });
  LEGAL_SRC = (
    await env.repos.ingestion.upsertDocument({
      sourceId: null,
      type: 'code',
      officialNumber: 'T',
      adoptedAt: null,
      title: 'Tax Code',
      language: 'az',
      sourceUrl: 'https://e-qanun.az/x',
      canonicalUrl: 'https://e-qanun.az/x',
    })
  ).id;
  adminToken = (await env.login(env.admin.email)).accessToken;
  viewerToken = (await env.login(env.viewer.email)).accessToken;

  await insert({
    id: '11111111-1111-4111-8111-111111111111',
    taxType: 'VAT',
    code: 'STANDARD',
    ratePercent: '18',
    validFrom: '2001-01-01',
    validTo: '2030-06-30',
    legalSourceId: LEGAL_SRC,
  });
  await insert({
    id: '33333333-3333-4333-8333-333333333333',
    taxType: 'VAT',
    code: 'STANDARD',
    ratePercent: '20',
    validFrom: '2030-07-01',
  });
  await insert({
    id: '44444444-4444-4444-8444-444444444444',
    taxType: 'VAT',
    code: 'ZERO',
    ratePercent: '0',
    validFrom: '2001-01-01',
    treatment: 'zero_rated',
  });
  await insert({
    id: '55555555-5555-4555-8555-555555555555',
    taxType: 'VAT',
    code: 'EXEMPT',
    ratePercent: '0',
    validFrom: '2001-01-01',
    treatment: 'exempt',
  });
  await insert({
    id: '66666666-6666-4666-8666-666666666666',
    taxType: 'WITHHOLDING',
    code: 'WHT_10',
    ratePercent: '10',
    validFrom: '2001-01-01',
  });
  await insert({
    id: '77777777-7777-4777-8777-777777777777',
    taxType: 'VAT',
    code: 'FUTURE',
    ratePercent: '25',
    validFrom: '2031-01-01',
    status: 'proposed',
  });
});
afterAll(() => env.close());

describe('tax_rates constraints (DB-level guarantees behind the engine)', () => {
  it('rejects overlapping ACTIVE rates for the same (type, code) — the engine can never be ambiguous', async () => {
    await expect(
      insert({
        taxType: 'VAT',
        code: 'STANDARD',
        ratePercent: '19',
        validFrom: '2030-06-15',
        validTo: '2030-12-31',
      }),
    ).rejects.toMatchObject({
      kind: 'CONFLICT',
    });
    // son gün daxildir: 2030-06-30 məşğuldur
    await expect(
      insert({
        taxType: 'VAT',
        code: 'STANDARD',
        ratePercent: '19',
        validFrom: '2030-06-30',
        validTo: '2030-06-30',
      }),
    ).rejects.toBeDefined();
  });

  it('allows adjacent periods, other codes/types, and overlapping PROPOSED rates', async () => {
    await expect(
      insert({ taxType: 'VAT', code: 'REDUCED', ratePercent: '8', validFrom: '2030-06-15' }),
    ).resolves.toBeDefined();
    await expect(
      insert({ taxType: 'PROFIT', code: 'STANDARD', ratePercent: '20', validFrom: '2001-01-01' }),
    ).resolves.toBeDefined();
    await expect(
      insert({
        taxType: 'VAT',
        code: 'STANDARD',
        ratePercent: '21',
        validFrom: '2030-01-01',
        status: 'proposed',
      }),
    ).resolves.toBeDefined();
  });

  it('enforces value sanity', async () => {
    const bad = (over: Partial<RateInput>) =>
      insert({ taxType: 'VAT', code: 'BAD', ratePercent: '5', validFrom: '2001-01-01', ...over });
    await expect(bad({ ratePercent: '100.01' })).rejects.toMatchObject({ kind: 'CONSTRAINT' });
    await expect(bad({ validFrom: '2030-02-01', validTo: '2030-01-01' })).rejects.toMatchObject({
      kind: 'CONSTRAINT',
    });
    await expect(bad({ taxType: 'INCOME', treatment: 'taxable' })).rejects.toMatchObject({
      kind: 'CONSTRAINT',
    });
    await expect(bad({ treatment: 'exempt', ratePercent: '5' })).rejects.toMatchObject({
      kind: 'CONSTRAINT',
    });
  });

  it('dates round-trip as YYYY-MM-DD strings regardless of timezone', async () => {
    const rates = await env.repos.taxRates.list({ taxType: 'VAT' });
    const old = rates.find((r) => r.id === '11111111-1111-4111-8111-111111111111')!;
    expect([old.validFrom, old.validTo]).toEqual(['2001-01-01', '2030-06-30']);
    expect(old.ratePercent.eq(new D('18'))).toBe(true);
  });
});

describe('engine fed from the database', () => {
  it('uses the rate in force on the operation date, with the legal source', async () => {
    const rates = await env.repos.taxRates.listActive();
    const before = vat.calculate('100.00', 'STANDARD', '2030-06-30', rates);
    const after = vat.calculate('100.00', 'STANDARD', '2030-07-01', rates);
    expect([formatAmount(before.vat), before.rateSourceId]).toEqual(['18.00', LEGAL_SRC]);
    expect([formatAmount(after.vat), after.rateSourceId]).toEqual(['20.00', null]);
    expect(vat.calculate('50.00', 'EXEMPT', '2030-07-01', rates).treatment).toBe('exempt');
    expect(
      formatAmount(withholding.calculate('1000', 'WHT_10', '2030-07-01', rates).withheld),
    ).toBe('100.00');
  });

  it('proposed rates are invisible to the engine', async () => {
    const rates = await env.repos.taxRates.listActive();
    expect(() => vat.calculate('1', 'FUTURE', '2031-06-01', rates)).toThrowError(
      expect.objectContaining({ code: 'RATE_NOT_FOUND' }),
    );
  });
});

describe('GET /api/v1/tax-rates', () => {
  const get = (token: string, qs = '') =>
    env.app.inject({ method: 'GET', url: `/api/v1/tax-rates${qs}`, headers: env.bearer(token) });

  it('requires auth and vat:read', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/api/v1/tax-rates' })).statusCode).toBe(
      401,
    );
    expect((await get(viewerToken)).statusCode).toBe(200); // viewer vat:read var
  });

  it('lists active rates by default, with string percentages', async () => {
    const res = await get(adminToken, '?taxType=VAT');
    expect(res.statusCode).toBe(200);
    const items = res.json() as Array<{
      id: string;
      code: string;
      ratePercent: string;
      status: string;
      treatment: string | null;
    }>;
    expect(items.every((i) => i.status === 'active')).toBe(true);
    expect(items.find((i) => i.id === '11111111-1111-4111-8111-111111111111')).toMatchObject({
      code: 'STANDARD',
      ratePercent: '18',
      treatment: null,
      validTo: '2030-06-30',
    });
    expect(items.some((i) => i.code === 'FUTURE')).toBe(false);
  });

  it('filters by effective date and by status', async () => {
    const on = (d: string) =>
      get(adminToken, `?taxType=VAT&date=${d}`).then((r) =>
        (r.json() as Array<{ code: string; ratePercent: string }>)
          .filter((x) => x.code === 'STANDARD')
          .map((x) => x.ratePercent),
      );
    expect(await on('2030-06-30')).toEqual(['18']);
    expect(await on('2030-07-01')).toEqual(['20']);
    const proposed = (await get(adminToken, '?status=proposed')).json() as Array<{ code: string }>;
    expect(proposed.map((p) => p.code)).toContain('FUTURE');
  });

  it('validates the query', async () => {
    expect((await get(adminToken, '?date=2030-02-30')).statusCode).toBe(422);
    expect((await get(adminToken, '?taxType=NOPE')).statusCode).toBe(422);
  });
});

describe('dev seed', () => {
  it('seeds sample VAT rates once and only when none exist', async () => {
    const { PgliteDb, migrate } = await import('../../src/db/index.js');
    const db = await PgliteDb.create();
    await migrate(db);
    expect((await seedDevTaxRates(db)).created).toBe(3);
    expect((await seedDevTaxRates(db)).created).toBe(0);
    await db.close();
    const rates: TaxRate[] = await env.repos.taxRates.listActive('VAT');
    expect(rates.length).toBeGreaterThan(0);
  });
});
