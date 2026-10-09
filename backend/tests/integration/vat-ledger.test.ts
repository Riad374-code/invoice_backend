import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, taxRate } from '../../src/accounting/index.js';
import { createTestEnv, type TestEnv } from '../helpers/app.js';

let env: TestEnv;
let admin: string;
let approver: string;
let other: string;
const get = (t: string, url: string) =>
  env.app.inject({ method: 'GET', url, headers: env.bearer(t) });
const post = (t: string, url: string, payload: object = {}) =>
  env.app.inject({ method: 'POST', url, headers: env.bearer(t), payload });

async function invoice(o: {
  companyId?: string;
  direction: 'sales' | 'purchase';
  number: string;
  date: string;
  status: string;
  currency?: string;
  lines: Array<[string, string, string]>;
}) {
  const companyId = o.companyId ?? env.companyA;
  const cp = await env.repos.invoices.upsertCounterparty(companyId, {
    name: 'CP',
    voen: '1234567891',
    isVatPayer: true,
  });
  const net = o.lines.reduce((a, l) => a.plus(l[1]), new D(0));
  const vat = o.lines.reduce((a, l) => a.plus(l[2]), new D(0));
  return env.repos.invoices.create({
    companyId,
    direction: o.direction,
    number: o.number,
    issueDate: o.date,
    counterpartyId: cp,
    currency: o.currency ?? 'AZN',
    net: net.toFixed(2),
    vat: vat.toFixed(2),
    gross: net.plus(vat).toFixed(2),
    status: o.status as 'validated',
    sourceFileId: null,
    extractionConfidence: null,
    templateVersion: null,
    lines: o.lines.map(([code, n, v]) => ({
      description: 'x',
      qty: '1',
      unitPrice: n,
      vatRateCode: code,
      net: n,
      vat: v,
    })),
  });
}

beforeAll(async () => {
  env = await createTestEnv({ loginRateLimitPerMinute: 1000 });
  for (const [code, pct, t] of [
    ['STANDARD', '18', null],
    ['ZERO', '0', 'zero_rated'],
    ['EXEMPT', '0', 'exempt'],
  ] as const) {
    await env.repos.taxRates.create(
      taxRate({
        id: crypto.randomUUID(),
        taxType: 'VAT',
        code,
        ratePercent: pct,
        validFrom: '2001-01-01',
        treatment: t,
      }),
    );
  }
  admin = (await env.login(env.admin.email)).accessToken;
  approver = (await env.login(env.approver.email)).accessToken;
  other = (await env.login(env.otherCompanyAdmin.email)).accessToken;
});
afterAll(() => env.close());

describe('VAT period summary', () => {
  beforeAll(async () => {
    await invoice({
      direction: 'sales',
      number: 'S1',
      date: '2030-03-05',
      status: 'validated',
      lines: [
        ['STANDARD', '1000.00', '180.00'],
        ['ZERO', '500.00', '0.00'],
        ['EXEMPT', '200.00', '0.00'],
      ],
    });
    await invoice({
      direction: 'purchase',
      number: 'P1',
      date: '2030-03-10',
      status: 'validated',
      lines: [['STANDARD', '400.00', '72.00']],
    });
    await invoice({
      direction: 'purchase',
      number: 'P2',
      date: '2030-03-11',
      status: 'needs_review',
      lines: [['STANDARD', '9999.00', '1799.82']],
    });
    await invoice({
      direction: 'sales',
      number: 'S-FOREIGN',
      date: '2030-03-12',
      status: 'validated',
      currency: 'USD',
      lines: [['STANDARD', '100.00', '18.00']],
    });
    await invoice({
      direction: 'sales',
      number: 'OTHER-MONTH',
      date: '2030-04-01',
      status: 'validated',
      lines: [['STANDARD', '100.00', '18.00']],
    });
    await invoice({
      companyId: env.companyB,
      direction: 'sales',
      number: 'B1',
      date: '2030-03-05',
      status: 'validated',
      lines: [['STANDARD', '77777.00', '14000.00']],
    });
  });

  it('output − input, exempt/zero-rated separate; unvalidated invoices excluded; missing FX blocks completeness', async () => {
    const s = (await get(admin, '/api/v1/vat/periods/2030-03/summary')).json();
    expect(s).toMatchObject({
      outputVat: '180.00',
      inputVat: '72.00',
      payable: '108.00',
      exemptTurnover: '200.00',
      zeroRatedTurnover: '500.00',
      taxableTurnover: '1000.00',
      complete: false,
    });
    expect(s.excluded.map((e: { number: string }) => e.number)).toEqual(['P2']);
    expect(s.blockers.map((b: { number: string }) => b.number)).toEqual(['S-FOREIGN']);
    expect(s.explanation.join(' ')).toMatch(/EXCLUDED/);
  });

  it('converts foreign-currency invoices with the CBAR rate of the issue date', async () => {
    await env.repos.vat.upsertFx([
      { currency: 'USD', date: '2030-03-12', rate: '1.700000', nominal: 1 },
    ]);
    const s = (await get(admin, '/api/v1/vat/periods/2030-03/summary')).json();
    expect(s).toMatchObject({ outputVat: '210.60', payable: '138.60', blockers: [] }); // 18.00 USD × 1.70 = 30.60
  });

  it('is tenant-scoped and validates the period', async () => {
    const b = (await get(other, '/api/v1/vat/periods/2030-03/summary')).json();
    expect(b.outputVat).toBe('14000.00');
    expect((await get(admin, '/api/v1/vat/periods/2030-13/summary')).statusCode).toBe(422);
  });

  it('draft return creates a NEW csv file + versioned return and changes no invoice', async () => {
    const before = await env.db.query(
      `SELECT id, status, updated_at FROM invoices WHERE company_id = $1 ORDER BY id`,
      [env.companyA],
    );
    const r = await post(admin, '/api/v1/vat/periods/2030-03/draft-return');
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ version: 1, summary: { payable: '138.60' } });
    const again = await post(admin, '/api/v1/vat/periods/2030-03/draft-return');
    expect(again.json().version).toBe(2);
    const content = await get(admin, `/api/v1/files/${r.json().draftFileId}/content`);
    expect(content.body).toContain('Payable (output');
    expect(content.body).toContain('138.60');
    expect(
      await env.db.query(
        `SELECT id, status, updated_at FROM invoices WHERE company_id = $1 ORDER BY id`,
        [env.companyA],
      ),
    ).toEqual(before);
  });

  it('refuses a draft while blockers exist', async () => {
    await env.db.query(`DELETE FROM fx_rates`);
    expect((await post(admin, '/api/v1/vat/periods/2030-03/draft-return')).statusCode).toBe(409);
  });
});

describe('ledger: proposal → approval → posted', () => {
  let invId: string;
  let entryId: string;
  beforeAll(async () => {
    invId = await invoice({
      direction: 'sales',
      number: 'L1',
      date: '2030-05-02',
      status: 'validated',
      lines: [['STANDARD', '100.00', '18.00']],
    });
    const r = await post(admin, `/api/v1/invoices/${invId}/propose-entries`);
    expect(r.statusCode).toBe(200);
    entryId = r.json().id;
  });

  it('a proposal is stored as a proposed entry and re-proposing replaces it (one open proposal)', async () => {
    const again = await post(admin, `/api/v1/invoices/${invId}/propose-entries`);
    expect(
      (await env.db.query(`SELECT 1 FROM journal_entries WHERE source_invoice_id = $1`, [invId]))
        .length,
    ).toBe(1);
    entryId = again.json().id;
    const e = (await get(admin, `/api/v1/journal/${entryId}`)).json();
    expect(e.status).toBe('proposed');
    expect(e.lines.map((l: { accountCode: string }) => l.accountCode).sort()).toEqual([
      '211',
      '533',
      '601',
    ]);
  });

  it('submit needs a different approver; self-approval is refused; approval posts entry AND invoice atomically', async () => {
    const sub = await post(admin, `/api/v1/journal/${entryId}/submit`);
    expect(sub.statusCode).toBe(202);
    const dup = await post(admin, `/api/v1/journal/${entryId}/submit`);
    expect(dup.json()).toMatchObject({ approvalId: sub.json().approvalId, reused: true });
    expect(
      (
        await post(admin, `/api/v1/approvals/${sub.json().approvalId}/decide`, {
          decision: 'approve',
        })
      ).statusCode,
    ).toBe(403);
    expect((await get(admin, `/api/v1/journal/${entryId}`)).json().status).toBe('proposed');

    expect(
      (
        await post(approver, `/api/v1/approvals/${sub.json().approvalId}/decide`, {
          decision: 'approve',
        })
      ).statusCode,
    ).toBe(200);
    const e = (await get(admin, `/api/v1/journal/${entryId}`)).json();
    expect(e.status).toBe('posted');
    expect(e.postedAt).toBeTruthy();
    expect((await get(admin, `/api/v1/invoices/${invId}`)).json().status).toBe('posted');
    expect((await post(admin, `/api/v1/invoices/${invId}/propose-entries`)).statusCode).toBe(409);
  });

  it('posted entries are immutable at DB level; unbalanced entries can never be approved', async () => {
    await expect(
      env.db.query(`UPDATE journal_lines SET debit = 1 WHERE entry_id = $1`, [entryId]),
    ).rejects.toMatchObject({ kind: 'CONSTRAINT' });
    await expect(
      env.db.query(`DELETE FROM journal_entries WHERE id = $1`, [entryId]),
    ).rejects.toMatchObject({ kind: 'CONSTRAINT' });
    const bad = await env.repos.ledger.createEntry({
      companyId: env.companyA,
      entryDate: '2030-05-03',
      description: 'bad',
      source: 'manual',
      sourceInvoiceId: null,
      createdBy: env.admin.id,
      lines: [
        { accountCode: '211', debit: '10.00', credit: '0' },
        { accountCode: '601', debit: '0', credit: '9.99' },
      ],
    });
    await expect(
      env.db.query(`UPDATE journal_entries SET status = 'approved' WHERE id = $1`, [bad]),
    ).rejects.toMatchObject({ kind: 'CONSTRAINT' });
    const sub = await post(admin, `/api/v1/journal/${bad}/submit`);
    expect(sub.statusCode).toBe(422);
  });

  it('a rejected approval leaves the entry proposed and re-submittable; other companies get 404', async () => {
    const inv2 = await invoice({
      direction: 'purchase',
      number: 'L2',
      date: '2030-05-04',
      status: 'validated',
      lines: [['STANDARD', '50.00', '9.00']],
    });
    const e2 = (await post(admin, `/api/v1/invoices/${inv2}/propose-entries`)).json().id;
    const sub = await post(admin, `/api/v1/journal/${e2}/submit`);
    expect(
      (
        await post(approver, `/api/v1/approvals/${sub.json().approvalId}/decide`, {
          decision: 'reject',
        })
      ).statusCode,
    ).toBe(200);
    expect((await get(admin, `/api/v1/journal/${e2}`)).json().status).toBe('proposed');
    expect((await post(admin, `/api/v1/journal/${e2}/submit`)).json().reused).toBe(false);
    expect((await get(other, `/api/v1/journal/${e2}`)).statusCode).toBe(404);
    expect((await post(other, `/api/v1/journal/${e2}/submit`)).statusCode).toBe(404);
  });

  it('chart import enforces account membership on posting', async () => {
    const put = await env.app.inject({
      method: 'PUT',
      url: '/api/v1/chart-of-accounts',
      headers: env.bearer(admin),
      payload: {
        name: 'T',
        accounts: [
          { code: '211', nameAz: 'A', type: 'asset' },
          { code: '601', nameAz: 'B', type: 'revenue' },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(
      (await get(admin, '/api/v1/accounts')).json().map((a: { code: string }) => a.code),
    ).toEqual(['211', '601']);
    const inv3 = await invoice({
      direction: 'sales',
      number: 'L3',
      date: '2030-05-05',
      status: 'validated',
      lines: [['STANDARD', '10.00', '1.80']],
    });
    const e3 = (await post(admin, `/api/v1/invoices/${inv3}/propose-entries`)).json().id; // 533 planda yoxdur
    expect((await post(admin, `/api/v1/journal/${e3}/submit`)).statusCode).toBe(422);
  });
});

describe('CBAR rates', () => {
  const xml = (d: string, v = '1.7000') =>
    `<?xml version="1.0"?><ValCurs Date="${d}"><ValType Type="Xarici valyutalar"><Valute Code="USD"><Nominal>1</Nominal><Value>${v}</Value></Valute><Valute Code="JPY"><Nominal>100</Nominal><Value>1.2345</Value></Valute></ValType></ValCurs>`;
  it('parses, stores via the job, and rejects malformed/mismatched data', async () => {
    const { parseCbarXml } = await import('../../src/ingestion/cbar.js');
    expect(parseCbarXml(xml('09.10.2030'))).toEqual({
      date: '2030-10-09',
      rates: [
        { currency: 'USD', rate: '1.7000', nominal: 1 },
        { currency: 'JPY', rate: '1.2345', nominal: 100 },
      ],
    });
    expect(() => parseCbarXml(xml('09.10.2030', '-1'))).toThrow();
    expect(() => parseCbarXml('<ValCurs/>')).toThrow();
    const { fxCbarHandler } = await import('../../src/jobs/ingestion.js');
    const deps = {
      db: env.db,
      repos: env.repos,
      storage: env.storage,
      extractors: env.extractors,
      log: { info() {}, warn() {}, error() {} },
      fetcher: {
        get: async () => ({
          url: '',
          status: 200,
          contentType: 'text/xml',
          body: xml('09.10.2030'),
        }),
      },
    };
    await fxCbarHandler({ payload: { date: '2030-10-09' } } as never, deps);
    expect(
      (await env.repos.assistant.listFxRates(['USD', 'JPY'], '2030-10-09', '2030-10-09')).length,
    ).toBe(2);
    await expect(fxCbarHandler({ payload: { date: '2030-10-10' } } as never, deps)).rejects.toThrow(
      /expected 2030-10-10/,
    );
  });
});
