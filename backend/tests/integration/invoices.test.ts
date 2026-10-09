import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvoiceParseError, parseInvoiceXml } from '../../src/documents/etaxes.js';
import { taxRate } from '../../src/accounting/index.js';
import { createTestEnv, type TestEnv } from '../helpers/app.js';
import { multipart } from '../helpers/multipart.js';

const xml = (
  o: {
    number?: string;
    date?: string;
    vat?: string;
    sellerVoen?: string;
    buyerVoen?: string;
    rate?: string;
    net?: string;
    gross?: string;
  } = {},
) => `<?xml version="1.0" encoding="UTF-8"?>
<invoice version="1">
  <number>${o.number ?? 'AA 0001234'}</number><date>${o.date ?? '2030-05-01'}</date><currency>AZN</currency>
  <seller><name>Təchizatçı MMC</name><voen>${o.sellerVoen ?? '1234567891'}</voen><vatPayer>true</vatPayer></seller>
  <buyer><name>Alpha MMC</name><voen>${o.buyerVoen ?? '9999999999'}</voen></buyer>
  <items>
    <item><name>Item A</name><qty>2</qty><price>25.00</price><vatRate code="${o.rate ?? 'STANDARD'}"/><net>${o.net ?? '50.00'}</net><vat>${o.vat ?? '9.00'}</vat></item>
    <item><name>Item B</name><qty>1</qty><price>100.00</price><vatRate code="STANDARD"/><net>100.00</net><vat>18.00</vat></item>
  </items>
  <totals><net>150.00</net><vat>27.00</vat><gross>177.00</gross></totals>
</invoice>`;

describe('parseInvoiceXml (deterministic template parser)', () => {
  it('parses amounts as exact strings (never floats)', () => {
    const p = parseInvoiceXml(xml())!;
    expect(p.templateVersion).toBe('etaxes-v1');
    expect(p.lines.map((l) => [l.qty, l.unitPrice, l.net, l.vat])).toEqual([
      ['2', '25.00', '50.00', '9.00'],
      ['1', '100.00', '100.00', '18.00'],
    ]);
    expect(p.seller.voen).toBe('1234567891');
  });
  it('rejects DTD/entity tricks (XXE, billion laughs) and malformed input', () => {
    expect(() =>
      parseInvoiceXml(
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><invoice/>',
      ),
    ).toThrow(InvoiceParseError);
    expect(() => parseInvoiceXml('<invoice><number>1</invoice>')).toThrow(InvoiceParseError);
  });
  it('returns null for XML that is not a known invoice, and errors on missing required elements', () => {
    expect(parseInvoiceXml('<other><a/></other>')).toBeNull();
    expect(() =>
      parseInvoiceXml(
        '<invoice><seller><name>x</name></seller><items><item><name>a</name></item></items></invoice>',
      ),
    ).toThrow(InvoiceParseError);
  });
});

let env: TestEnv;
let admin: string;
let viewer: string;
let other: string;

beforeAll(async () => {
  env = await createTestEnv({ loginRateLimitPerMinute: 1000 });
  for (const r of [
    taxRate({
      id: crypto.randomUUID(),
      taxType: 'VAT',
      code: 'STANDARD',
      ratePercent: '18',
      validFrom: '2001-01-01',
    }),
    taxRate({
      id: crypto.randomUUID(),
      taxType: 'VAT',
      code: 'ZERO',
      ratePercent: '0',
      validFrom: '2001-01-01',
      treatment: 'zero_rated',
    }),
  ])
    await env.repos.taxRates.create(r);
  admin = (await env.login(env.admin.email)).accessToken;
  viewer = (await env.login(env.viewer.email)).accessToken;
  other = (await env.login(env.otherCompanyAdmin.email)).accessToken;
});
afterAll(() => env.close());

async function importXml(content: string, token = admin) {
  const { payload, headers } = multipart({ name: 'inv.xml', content, type: 'application/xml' });
  const res = await env.app.inject({
    method: 'POST',
    url: '/api/v1/invoices/upload',
    payload,
    headers: { ...env.bearer(token), ...headers },
  });
  expect(res.statusCode, res.body).toBe(202);
  await env.worker.drain();
  const list = await env.app.inject({
    method: 'GET',
    url: '/api/v1/invoices?limit=100',
    headers: env.bearer(token),
  });
  return list.json().items as Array<{ id: string; number: string; status: string }>;
}
const get = (t: string, url: string) =>
  env.app.inject({ method: 'GET', url, headers: env.bearer(t) });
const post = (t: string, url: string, payload?: object) =>
  env.app.inject({ method: 'POST', url, headers: env.bearer(t), payload });

describe('upload → parse → validate (e-qaimə, AI-sız)', () => {
  it('creates counterparty, invoice and lines, validates, and records the import job', async () => {
    const items = await importXml(xml());
    const inv = items.find((i) => i.number === 'AA 0001234')!;
    expect(inv.status).toBe('validated');
    const d = (await get(admin, `/api/v1/invoices/${inv.id}`)).json();
    expect(d).toMatchObject({
      direction: 'purchase',
      currency: 'AZN',
      net: '150.00',
      vat: '27.00',
      gross: '177.00',
      extractionConfidence: '1.000',
      templateVersion: 'etaxes-v1',
      counterparty: { name: 'Təchizatçı MMC', voen: '1234567891', isVatPayer: true },
    });
    expect(d.lines).toHaveLength(2);
    expect(d.issues).toEqual([]);
    const [job] = await env.db.query<{ status: string; rows_ok: number; template_version: string }>(
      `SELECT status, rows_ok, template_version FROM import_jobs ORDER BY created_at DESC LIMIT 1`,
    );
    expect(job).toMatchObject({ status: 'done', rows_ok: 1, template_version: 'etaxes-v1' });
  });

  it('wrong VAT on a line → VAT_RATE_MISMATCH issue, status needs_review, and propose-entries is blocked (409)', async () => {
    const items = await importXml(xml({ number: 'BAD 1', vat: '10.00' }));
    const inv = items.find((i) => i.number === 'BAD 1')!;
    expect(inv.status).toBe('needs_review');
    const d = (await get(admin, `/api/v1/invoices/${inv.id}`)).json();
    expect(d.issues.map((i: { code: string }) => i.code)).toContain('VAT_RATE_MISMATCH');
    expect((await post(admin, `/api/v1/invoices/${inv.id}/propose-entries`, {})).statusCode).toBe(
      409,
    );
  });

  it('flags duplicates on re-import of the same invoice', async () => {
    await importXml(xml({ number: 'DUP 1' }));
    const items = await importXml(xml({ number: 'DUP 1' }));
    const dups = items.filter((i) => i.number === 'DUP 1');
    expect(dups).toHaveLength(2);
    const flagged = await Promise.all(
      dups.map(async (i) =>
        (await get(admin, `/api/v1/invoices/${i.id}`))
          .json()
          .issues.some((x: { code: string }) => x.code === 'DUPLICATE_INVOICE'),
      ),
    );
    expect(flagged).toContain(true);
  });

  it('direction is sales when the seller is our company', async () => {
    const company = (await env.repos.companies.findById(env.companyA))!;
    const items = await importXml(
      xml({ number: 'SALE 1', sellerVoen: company.voen, buyerVoen: '1234567891' }),
    );
    const inv = items.find((i) => i.number === 'SALE 1')!;
    expect((await get(admin, `/api/v1/invoices/${inv.id}`)).json().direction).toBe('sales');
  });

  it('an unrecognised XML fails the import job cleanly (no invoice, no retry loop)', async () => {
    const before = (await get(admin, '/api/v1/invoices?limit=100')).json().items.length;
    await importXml('<?xml version="1.0"?><something><else/></something>');
    expect((await get(admin, '/api/v1/invoices?limit=100')).json().items.length).toBe(before);
    const [job] = await env.db.query<{ status: string; error: string }>(
      `SELECT status, error FROM import_jobs ORDER BY created_at DESC LIMIT 1`,
    );
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/template/);
  });
});

describe('propose-entries, PATCH and state machine (A-04)', () => {
  it('proposes a balanced entry from a validated invoice; line account override is used', async () => {
    const items = await importXml(xml({ number: 'PROP 1' }));
    const inv = items.find((i) => i.number === 'PROP 1')!;
    const d = (await get(admin, `/api/v1/invoices/${inv.id}`)).json();
    const patch = await env.app.inject({
      method: 'PATCH',
      url: `/api/v1/invoices/${inv.id}`,
      headers: env.bearer(admin),
      payload: { lines: [{ id: d.lines[0].id, accountFinal: '201' }] },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().status).toBe('extracted'); // düzəliş → yenidən yoxlama tələb olunur
    expect((await post(admin, `/api/v1/invoices/${inv.id}/propose-entries`, {})).statusCode).toBe(
      409,
    );

    expect((await post(admin, `/api/v1/invoices/${inv.id}/validate`)).json().status).toBe(
      'validated',
    );
    const res = await post(admin, `/api/v1/invoices/${inv.id}/propose-entries`, {});
    expect(res.statusCode).toBe(200);
    const e = res.json();
    expect(e.status).toBe('proposed');
    const sum = (k: 'debit' | 'credit') =>
      e.lines.reduce(
        (a: number, l: Record<string, string>) => a + Math.round(Number(l[k]) * 100),
        0,
      );
    expect(sum('debit')).toBe(sum('credit'));
    expect(e.lines.find((l: { accountCode: string }) => l.accountCode === '201').debit).toBe(
      '50.00',
    );
    expect(e.lines.find((l: { accountCode: string }) => l.accountCode === '241').debit).toBe(
      '27.00',
    );
    expect(e.lines.find((l: { accountCode: string }) => l.accountCode === '521').credit).toBe(
      '177.00',
    );
  });

  it('a posted invoice is immutable (409); invalid status values and foreign lines are rejected', async () => {
    const items = await importXml(xml({ number: 'POST 1' }));
    const inv = items.find((i) => i.number === 'POST 1')!;
    await env.db.query(`UPDATE invoices SET status = 'posted' WHERE id = $1`, [inv.id]);
    const patch = (payload: object) =>
      env.app.inject({
        method: 'PATCH',
        url: `/api/v1/invoices/${inv.id}`,
        headers: env.bearer(admin),
        payload,
      });
    expect((await patch({ number: 'X' })).statusCode).toBe(409);
    expect((await post(admin, `/api/v1/invoices/${inv.id}/validate`)).statusCode).toBe(409);
    expect((await get(admin, '/api/v1/invoices?status=bogus')).statusCode).toBe(422);
    const other2 = (await importXml(xml({ number: 'OWN 1' }))).find((i) => i.number === 'OWN 1')!;
    const foreign = (await get(admin, `/api/v1/invoices/${inv.id}`)).json().lines[0].id;
    const r = await env.app.inject({
      method: 'PATCH',
      url: `/api/v1/invoices/${other2.id}`,
      headers: env.bearer(admin),
      payload: { lines: [{ id: foreign, accountFinal: '201' }] },
    });
    expect(r.statusCode).toBe(422);
  });

  it('edits and validations are audited with before/after', async () => {
    const acts = (await env.repos.audit.listByCompany(env.companyA, 500)).map((e) => e.action);
    expect(acts).toEqual(
      expect.arrayContaining(['invoice.update', 'invoice.validate', 'file.upload']),
    );
  });
});

describe('tenant isolation and permissions', () => {
  it("another company never sees or touches a company's invoices (404, not 403)", async () => {
    const items = await importXml(xml({ number: 'TENANT 1' }));
    const inv = items.find((i) => i.number === 'TENANT 1')!;
    expect((await get(other, `/api/v1/invoices/${inv.id}`)).statusCode).toBe(404);
    expect((await post(other, `/api/v1/invoices/${inv.id}/validate`)).statusCode).toBe(404);
    expect(
      (
        await env.app.inject({
          method: 'PATCH',
          url: `/api/v1/invoices/${inv.id}`,
          headers: env.bearer(other),
          payload: { number: 'HACK' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await get(other, '/api/v1/invoices?limit=100'))
        .json()
        .items.map((i: { id: string }) => i.id),
    ).not.toContain(inv.id);
  });

  it('viewer can read but not write; unknown ids are 404', async () => {
    expect((await get(viewer, '/api/v1/invoices')).statusCode).toBe(200);
    const { payload, headers } = multipart({
      name: 'a.xml',
      content: xml({ number: 'V 1' }),
      type: 'application/xml',
    });
    expect(
      (
        await env.app.inject({
          method: 'POST',
          url: '/api/v1/invoices/upload',
          payload,
          headers: { ...env.bearer(viewer), ...headers },
        })
      ).statusCode,
    ).toBe(403);
    expect((await get(admin, `/api/v1/invoices/${crypto.randomUUID()}`)).statusCode).toBe(404);
  });

  it('pagination walks all invoices exactly once', async () => {
    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 20; i++) {
      const r = (await get(admin, `/api/v1/invoices?limit=2${cursor}`)).json();
      seen.push(...r.items.map((x: { id: string }) => x.id));
      if (!r.nextCursor) break;
      cursor = `&cursor=${r.nextCursor}`;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe((await get(admin, '/api/v1/invoices?limit=100')).json().items.length);
  });
});
