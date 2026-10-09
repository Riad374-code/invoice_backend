import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { D, taxRate } from '../../src/accounting/index.js';
import {
  cleanTable,
  normalizeAmount,
  normalizeDate,
  profileTable,
} from '../../src/documents/excel-ops.js';
import { readTable, writeWorkbook } from '../../src/documents/table.js';
import { reconcileItems, normKey, type ReconItem } from '../../src/recon/match.js';
import { createTestEnv, type TestEnv } from '../helpers/app.js';
import { multipart } from '../helpers/multipart.js';

describe('normalizeAmount / normalizeDate', () => {
  it.each([
    ['1234.50', '1234.5'],
    ['1 234,50', '1234.50'],
    ['1.234,50', '1234.50'],
    ['1,234.50', '1234.50'],
    ['(100.00)', '-100.00'],
    ['-5 AZN', '-5'],
    ['1,234', '1234'],
    ['1.234.567', '1234567'],
    ['0,5', '0.5'],
    ['  12 ₼ ', '12'],
    ['+7', '7'],
    ['007', '7'],
  ])('amount %j → %j', (raw, want) =>
    expect(normalizeAmount(raw)).toBe(want === '1234.5' ? '1234.50' : want),
  );
  it.each(['', 'abc', '1,2,3,4', '12.3.4', '--5', '1e5', '١٢٣'])('rejects %j', (raw) =>
    expect(normalizeAmount(raw)).toBeNull(),
  );
  it('dates: ISO and dd.mm.yyyy only when the day exists', () => {
    expect(normalizeDate('05.03.2030')).toBe('2030-03-05');
    expect(normalizeDate('5/3/2030')).toBe('2030-03-05');
    expect(normalizeDate('2030-03-05T10:00:00')).toBe('2030-03-05');
    for (const bad of ['30.02.2030', '2030-13-01', '03/05/30', 'tomorrow', ''])
      expect(normalizeDate(bad), bad).toBeNull();
  });
});

describe('profile / clean (pure)', () => {
  const headers = ['Nömrə', 'Tarix', 'Məbləğ', 'Qeyd'];
  const rows = [
    ['A1', '05.03.2030', '1 234,50', ' x '],
    ['A2', '2030-03-06', '10', ''],
    ['A2', '2030-03-06', '10', ''],
    ['', '', '', ''],
    ['A3', '07.03.2030', 'oops', 'y'],
  ];
  it('profile uses exact decimals and counts duplicates/empties', () => {
    const p = profileTable(headers, rows);
    expect(p).toMatchObject({ rows: 5, emptyRows: 1, duplicateRows: 1 });
    const amount = p.columns[2]!;
    expect(amount.type).toBe('text'); // 3/4 = 75% < 90% → mətn (qismən tanınan sütun "rəqəm" sayılmır)
  });
  it('clean normalises only columns that are mostly numeric/date, reports every change, drops empty + duplicate rows, never touches input', () => {
    const good = [
      ['A1', '05.03.2030', '1 234,50', ' x '],
      ['A2', '2030-03-06', '10', ''],
      ['A2', '2030-03-06', '10', ''],
      ['', '', '', ''],
    ];
    const copy = JSON.stringify(good);
    const c = cleanTable(headers, good, { dedupe: true });
    expect(c.rows).toEqual([
      ['A1', '2030-03-05', '1234.50', 'x'],
      ['A2', '2030-03-06', '10', ''],
    ]);
    expect(c.log).toMatchObject({
      amountsNormalized: 1,
      datesNormalized: 1,
      emptyRowsRemoved: 1,
      duplicatesRemoved: 1,
      trimmed: 1,
    });
    expect(JSON.stringify(good)).toBe(copy);
    expect(cleanTable(headers, good, { dedupe: false }).rows).toHaveLength(3);
  });
  it('sums are exact (0.1 + 0.2)', () => {
    const p = profileTable(
      ['v'],
      [['0.1'], ['0.2'], ['0.3'], ['0.4'], ['0.5'], ['0.6'], ['0.7'], ['0.8'], ['0.9'], ['1.0']],
    );
    expect(p.columns[0]!.sum).toBe('5.5');
    expect(profileTable(['v'], [['0.1'], ['0.2']]).columns[0]!.sum).toBe('0.3');
  });
});

describe('reconcileItems', () => {
  const it_ = (
    ref: string,
    key: string,
    amount: string,
    date: string | null = null,
  ): ReconItem => ({ ref, key: normKey(key), amount: new D(amount), date });
  const kinds = (ms: ReturnType<typeof reconcileItems>) =>
    ms.map((m) => `${m.type}:${m.left?.ref ?? '-'}/${m.right?.ref ?? '-'}`);
  it('exact → mismatch → date/amount → leftovers; strictly one-to-one', () => {
    const m = reconcileItems(
      [
        it_('l1', 'AA-1', '100'),
        it_('l2', 'AA-2', '50'),
        it_('l3', '', '30', '2030-01-10'),
        it_('l4', 'ZZ', '5'),
      ],
      [
        it_('r1', 'aa 1', '100.00'),
        it_('r2', 'AA2', '55'),
        it_('r3', '', '30', '2030-01-12'),
        it_('r4', 'NEW', '9'),
      ],
    );
    expect(kinds(m)).toEqual([
      'exact:l1/r1',
      'amount_mismatch:l2/r2',
      'amount_date:l3/r3',
      'unmatched_left:l4/-',
      'unmatched_right:-/r4',
    ]);
    expect(m[1]!.difference!.toString()).toBe('-5');
  });
  it('never guesses between equally good candidates and never reuses an item', () => {
    const amb = reconcileItems(
      [it_('l1', '', '10', '2030-01-10')],
      [it_('r1', '', '10', '2030-01-11'), it_('r2', '', '10', '2030-01-09')],
    );
    expect(amb.every((x) => x.type.startsWith('unmatched'))).toBe(true);
    const dup = reconcileItems([it_('l1', 'K', '1'), it_('l2', 'K', '1')], [it_('r1', 'K', '1')]);
    expect(kinds(dup)).toEqual(['exact:l1/r1', 'unmatched_left:l2/-']);
  });
});

describe('xlsx round trip', () => {
  it('keeps text exactly (leading zeros, formula-looking text) and reads numbers/dates/formulas', async () => {
    const buf = await writeWorkbook([
      {
        name: 'S',
        headers: ['voen', 'note', 'amt'],
        rows: [
          ['0123456789', '=1+1', '1234.50'],
          ['+994501234567', '@x', '-5'],
        ],
      },
    ]);
    const t = await readTable(buf, 'xlsx');
    expect(t.rows).toEqual([
      ['0123456789', '=1+1', '1234.50'],
      ['+994501234567', '@x', '-5'],
    ]);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('x');
    ws.addRow(['n', 'd', 'f']);
    ws.addRow([0.1, new Date('2030-03-05T00:00:00Z'), { formula: 'A2*2', result: 0.2 }]);
    const r = await readTable(Buffer.from(await wb.xlsx.writeBuffer()), 'xlsx');
    expect(r.rows).toEqual([['0.1', '2030-03-05', '0.2']]);
  });
  it('CSV values stay verbatim (no date/number auto-conversion, leading zeros kept); semicolon CSV works; empty files are rejected', async () => {
    const t = await readTable(Buffer.from('a;b\n1;2\n3;4\n'), 'csv');
    expect(t).toMatchObject({
      headers: ['a', 'b'],
      rows: [
        ['1', '2'],
        ['3', '4'],
      ],
    });
    const raw = await readTable(Buffer.from('d,v\n2030-03-05,0012\n'), 'csv');
    expect(raw.rows).toEqual([['2030-03-05', '0012']]);
    await expect(readTable(Buffer.from(''), 'csv')).rejects.toThrow();
  });
});

// ------------------------------------------------------------------ API flows
let env: TestEnv;
let admin: string;
let approver: string;
let viewer: string;
let other: string;
const get = (t: string, url: string) =>
  env.app.inject({ method: 'GET', url, headers: env.bearer(t) });
const post = (t: string, url: string, payload: object = {}) =>
  env.app.inject({ method: 'POST', url, headers: env.bearer(t), payload });
async function upload(name: string, content: Buffer | string, type: string, tok = admin) {
  const { payload, headers } = multipart({ name, content, type });
  const res = await env.app.inject({
    method: 'POST',
    url: '/api/v1/files',
    payload,
    headers: { ...env.bearer(tok), ...headers },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
const xlsx = (headers: string[], rows: string[][]) => writeWorkbook([{ name: 'S', headers, rows }]);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

beforeAll(async () => {
  env = await createTestEnv({ loginRateLimitPerMinute: 1000 });
  await env.repos.taxRates.create(
    taxRate({
      id: crypto.randomUUID(),
      taxType: 'VAT',
      code: 'STANDARD',
      ratePercent: '18',
      validFrom: '2001-01-01',
    }),
  );
  [admin, approver, viewer, other] = (await Promise.all(
    [env.admin, env.approver, env.viewer, env.otherCompanyAdmin].map(
      async (u) => (await env.login(u.email)).accessToken,
    ),
  )) as [string, string, string, string];
});
afterAll(() => env.close());

describe('excel jobs', () => {
  it('profile/clean/reconcile/report each end with a NEW output file; the original is byte-identical', async () => {
    const original = await xlsx(
      ['Nömrə', 'Məbləğ'],
      [
        ['A1', '1 234,50'],
        ['A1', '1 234,50'],
        ['A2', '10'],
      ],
    );
    const fileId = await upload('data.xlsx', original, XLSX);
    const before = (await env.repos.files.latestVersion(env.companyA, fileId))!.sha256;
    const run = async (body: object) => {
      const res = await post(admin, '/api/v1/excel/jobs', body);
      expect(res.statusCode, res.body).toBe(202);
      await env.worker.drain();
      return (await get(admin, `/api/v1/excel/jobs/${res.json().id}`)).json();
    };
    const prof = await run({ operation: 'profile', inputFileId: fileId });
    expect(prof).toMatchObject({ status: 'done', result: { rows: 3, duplicateRows: 1 } });
    expect(prof.result.columns[1]).toMatchObject({ type: 'number', sum: '2479' });
    const clean = await run({ operation: 'clean', inputFileId: fileId });
    expect(clean.result).toMatchObject({ rowsIn: 3, rowsOut: 2 });
    const rec = await run({
      operation: 'reconcile',
      params: {
        left: { type: 'file', fileId, keyColumn: 'Nömrə', amountColumn: 'Məbləğ' },
        right: { type: 'file', fileId, keyColumn: 'Nömrə', amountColumn: 'Məbləğ' },
      },
    });
    expect(rec.status).toBe('done');
    const report = await run({
      operation: 'report',
      params: { template: 'invoices', from: '2030-01-01', to: '2030-12-31' },
    });
    for (const j of [prof, clean, rec, report]) {
      expect(j.outputFileId).toBeTruthy();
      expect(j.outputFileId).not.toBe(fileId);
    }
    const out = await get(admin, `/api/v1/files/${clean.outputFileId}/content`);
    const t = await readTable(out.rawPayload, 'xlsx');
    expect(t.rows).toEqual([
      ['A1', '1234.50'],
      ['A2', '10'],
    ]);
    expect((await env.repos.files.latestVersion(env.companyA, fileId))!.sha256).toBe(before);
    expect(
      (
        await env.storage.get(
          (await env.repos.files.latestVersion(env.companyA, fileId))!.storageKey,
        )
      ).equals(original),
    ).toBe(true);
  });

  it('failures are visible on the job; foreign/unknown files are 404; viewer is 403', async () => {
    expect(
      (
        await post(admin, '/api/v1/excel/jobs', {
          operation: 'profile',
          inputFileId: crypto.randomUUID(),
        })
      ).statusCode,
    ).toBe(404);
    const fileId = await upload('x.xlsx', await xlsx(['a'], [['1']]), XLSX);
    expect(
      (await post(other, '/api/v1/excel/jobs', { operation: 'profile', inputFileId: fileId }))
        .statusCode,
    ).toBe(404);
    expect(
      (await post(viewer, '/api/v1/excel/jobs', { operation: 'profile', inputFileId: fileId }))
        .statusCode,
    ).toBe(403);
    const bad = await post(admin, '/api/v1/excel/jobs', {
      operation: 'reconcile',
      params: {
        left: { type: 'file', fileId, keyColumn: 'nope', amountColumn: 'a' },
        right: { type: 'bank' },
      },
    });
    await env.db.query(`UPDATE jobs SET max_attempts = 1`);
    await env.worker.drain();
    expect((await get(admin, `/api/v1/excel/jobs/${bad.json().id}`)).json()).toMatchObject({
      status: 'failed',
    });
    expect((await get(other, `/api/v1/excel/jobs/${bad.json().id}`)).statusCode).toBe(404);
  });
});

describe('reconciliations', () => {
  it('stores proposed matches; only paired matches can be confirmed (once, audited); tenant-isolated', async () => {
    const l = await upload('l.csv', 'ref,amt\nINV-1,100\nINV-2,50\nINV-9,7\n', 'text/csv');
    const r = await upload('r.csv', 'ref,amt\ninv 1,100\nINV-2,55\n', 'text/csv');
    const spec = (fileId: string) => ({
      type: 'file',
      fileId,
      keyColumn: 'ref',
      amountColumn: 'amt',
    });
    const res = await post(admin, '/api/v1/reconciliations', { left: spec(l), right: spec(r) });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().summary).toMatchObject({
      exact: 1,
      amountMismatch: 1,
      unmatchedLeft: 1,
      unmatchedRight: 0,
      leftTotal: '157.00',
      rightTotal: '155.00',
    });
    const rec = (await get(admin, `/api/v1/reconciliations/${res.json().id}`)).json();
    expect(rec.matches.every((m: { status: string }) => m.status === 'proposed')).toBe(true);
    const mism = rec.matches.find((m: { matchType: string }) => m.matchType === 'amount_mismatch');
    expect(mism.difference).toBe('-5.00');
    const confirm = (t: string, m: string) =>
      post(t, `/api/v1/reconciliations/${rec.id}/matches/${m}/confirm`);
    expect((await confirm(admin, mism.id)).statusCode).toBe(200);
    expect(
      (await get(admin, `/api/v1/reconciliations/${rec.id}`))
        .json()
        .matches.find((m: { id: string }) => m.id === mism.id).status,
    ).toBe('confirmed');
    expect(
      (
        await confirm(
          admin,
          rec.matches.find((m: { matchType: string }) => m.matchType === 'unmatched_left').id,
        )
      ).statusCode,
    ).toBe(409);
    expect((await confirm(other, mism.id)).statusCode).toBe(404);
    expect((await get(other, `/api/v1/reconciliations/${rec.id}`)).statusCode).toBe(404);
    expect((await env.repos.audit.listByCompany(env.companyA, 300)).map((e) => e.action)).toEqual(
      expect.arrayContaining(['reconciliation.run', 'reconciliation.confirm']),
    );
  });

  it('reports unreadable amounts instead of silently dropping them', async () => {
    const f = await upload('bad.csv', 'ref,amt\nA,10\nB,not-a-number\n', 'text/csv');
    const res = await post(admin, '/api/v1/reconciliations', {
      left: { type: 'file', fileId: f, keyColumn: 'ref', amountColumn: 'amt' },
      right: { type: 'bank' },
    });
    expect(res.json().summary).toMatchObject({ skipped: 1, unmatchedLeft: 1 });
  });
});

describe('import: preview → approval → commit', () => {
  const csv1c =
    'Nömrə;Tarix;Kontragent;VÖEN;Net;ƏDV;Növ\nAA-1;05.03.2030;Təchizatçı MMC;1234567891;100,00;18,00;alış\nAA-2;06.03.2030;X MMC;12345;50,00;9,00;alış\nAA-3;07.03.2030;Y MMC;1234567891;10,00;1,80;satış\n';
  let fileId: string;
  let importId: string;

  it('preview writes nothing, lists row errors, and needs the right columns', async () => {
    fileId = await upload('1c.csv', csv1c, 'text/csv');
    const before = (await env.db.query(`SELECT 1 FROM invoices`)).length;
    const p = await post(admin, '/api/v1/imports/preview', { source: '1c', fileId });
    expect(p.statusCode, p.body).toBe(201);
    expect(p.json()).toMatchObject({ template: 'onec-table-v1', rowsOk: 2, rowsFailed: 1 });
    expect(p.json().errors[0]).toMatchObject({ row: 3, errors: [expect.stringContaining('VÖEN')] });
    expect((await env.db.query(`SELECT 1 FROM invoices`)).length).toBe(before);
    importId = p.json().importId;
    const wrong = await upload('wrong.csv', 'a;b\n1;2\n', 'text/csv');
    expect(
      (await post(admin, '/api/v1/imports/preview', { source: '1c', fileId: wrong })).json(),
    ).toMatchObject({ rowsOk: 0, rowsFailed: 1 });
    expect(
      (await post(admin, '/api/v1/imports/preview', { source: 'etaxes', fileId })).statusCode,
    ).toBe(422);
  });

  it('commit requires approval by ANOTHER user; then creates invoices (validated) with an honest rows_ok/rows_failed report; cannot be committed twice', async () => {
    const req = await post(admin, `/api/v1/imports/${importId}/commit`);
    expect(req.statusCode).toBe(202);
    expect((await post(admin, `/api/v1/imports/${importId}/commit`)).json().reused).toBe(true);
    expect((await env.db.query(`SELECT 1 FROM invoices WHERE number LIKE 'AA-%'`)).length).toBe(0);
    expect(
      (
        await post(admin, `/api/v1/approvals/${req.json().approvalId}/decide`, {
          decision: 'approve',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await post(approver, `/api/v1/approvals/${req.json().approvalId}/decide`, {
          decision: 'approve',
        })
      ).statusCode,
    ).toBe(200);
    const imp = (await get(admin, `/api/v1/imports/${importId}`)).json();
    expect(imp).toMatchObject({ status: 'committed', rowsOk: 2, rowsFailed: 1 });
    const inv = (await get(admin, '/api/v1/invoices?limit=50')).json().items as Array<{
      number: string;
      status: string;
      direction: string;
    }>;
    expect(
      inv
        .filter((i) => i.number.startsWith('AA-'))
        .map((i) => `${i.number}:${i.direction}:${i.status}`)
        .sort(),
    ).toEqual(['AA-1:purchase:validated', 'AA-3:sales:validated']);
    expect((await post(admin, `/api/v1/imports/${importId}/commit`)).statusCode).toBe(409);
  });

  it('re-importing the same rows skips duplicates and reports them', async () => {
    const p = await post(admin, '/api/v1/imports/preview', { source: '1c', fileId });
    const req = await post(admin, `/api/v1/imports/${p.json().importId}/commit`);
    await post(approver, `/api/v1/approvals/${req.json().approvalId}/decide`, {
      decision: 'approve',
    });
    expect((await get(admin, `/api/v1/imports/${p.json().importId}`)).json()).toMatchObject({
      status: 'committed',
      rowsOk: 0,
      rowsFailed: 3,
    });
    expect((await env.db.query(`SELECT 1 FROM invoices WHERE number = 'AA-1'`)).length).toBe(1);
  });

  it('a rejected approval leaves the import previewed and re-requestable; other companies get 404; viewer 403', async () => {
    const p = await post(admin, '/api/v1/imports/preview', {
      source: 'bank',
      fileId: await upload(
        'bank.csv',
        'Tarix,Məbləğ,Təyinat,Referans\n2030-03-05,"1 000,50",Payment,INV-1\n2030-03-06,-20,Fee,\n',
        'text/csv',
      ),
    });
    expect(p.json()).toMatchObject({ rowsOk: 2, rowsFailed: 0, template: 'bank-table-v1' });
    const req = await post(admin, `/api/v1/imports/${p.json().importId}/commit`);
    await post(approver, `/api/v1/approvals/${req.json().approvalId}/decide`, {
      decision: 'reject',
    });
    expect((await get(admin, `/api/v1/imports/${p.json().importId}`)).json().status).toBe(
      'previewed',
    );
    expect((await post(admin, `/api/v1/imports/${p.json().importId}/commit`)).json().reused).toBe(
      false,
    );
    expect((await get(other, `/api/v1/imports/${p.json().importId}`)).statusCode).toBe(404);
    expect((await post(viewer, `/api/v1/imports/${p.json().importId}/commit`)).statusCode).toBe(
      403,
    );
    expect((await env.db.query(`SELECT 1 FROM bank_transactions`)).length).toBe(0);
  });

  it('bank import commits transactions that can then be reconciled against invoices', async () => {
    const p = await post(admin, '/api/v1/imports/preview', {
      source: 'bank',
      fileId: await upload(
        'bank2.csv',
        'Tarix,Məbləğ,Referans\n2030-03-05,-118.00,AA-1\n',
        'text/csv',
      ),
    });
    const req = await post(admin, `/api/v1/imports/${p.json().importId}/commit`);
    await post(approver, `/api/v1/approvals/${req.json().approvalId}/decide`, {
      decision: 'approve',
    });
    const rec = await post(admin, '/api/v1/reconciliations', {
      left: { type: 'invoices', from: '2030-03-01', to: '2030-03-31', direction: 'purchase' },
      right: { type: 'bank' },
    });
    expect(rec.json().summary).toMatchObject({ exact: 1 });
  });
});

describe('1C export', () => {
  it('exports only POSTED entries into a new file', async () => {
    const e = await env.repos.ledger.createEntry({
      companyId: env.companyA,
      entryDate: '2030-06-01',
      description: 'Satış; "test"',
      source: 'manual',
      sourceInvoiceId: null,
      createdBy: env.admin.id,
      lines: [
        { accountCode: '211', debit: '10.00', credit: '0' },
        { accountCode: '601', debit: '0', credit: '10.00' },
      ],
    });
    await env.repos.ledger.createEntry({
      companyId: env.companyA,
      entryDate: '2030-06-02',
      description: 'draft',
      source: 'manual',
      sourceInvoiceId: null,
      createdBy: env.admin.id,
      lines: [
        { accountCode: '211', debit: '1.00', credit: '0' },
        { accountCode: '601', debit: '0', credit: '1.00' },
      ],
    });
    await env.repos.ledger.approveAndPost(env.companyA, e, env.approver.id, new Date());
    const res = await post(admin, '/api/v1/journal/export-1c', {
      from: '2030-06-01',
      to: '2030-06-30',
    });
    expect(res.json().entries).toBe(1);
    const body = (await get(admin, `/api/v1/files/${res.json().fileId}/content`)).body;
    expect(body).toContain('#LEXAUDIT-1C;v1;2030-06-01;2030-06-30');
    expect(body).toContain(`;211;10.00;0.00;"Satış; ""test"""`);
    expect(body).not.toContain('draft');
  });
});
