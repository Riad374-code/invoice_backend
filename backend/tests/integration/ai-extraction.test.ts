import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractPdfText, looksScanned } from '../../src/documents/pdf.js';
import { resolveRateCode } from '../../src/invoices/ai-import.js';
import {
  HttpModelServing,
  ModelResponseError,
  type ExtractedInvoice,
  type ModelServing,
} from '../../src/models/client.js';
import { UpstreamError } from '../../src/rag/clients.js';
import { taxRate } from '../../src/accounting/index.js';
import { createTestEnv, type TestEnv } from '../helpers/app.js';
import { multipart } from '../helpers/multipart.js';

/** Əl ilə qurulan minimal, TAM etibarlı mətnli PDF (düzgün xref ofsetləri ilə). */
function makePdf(lines: string[]): Buffer {
  const content = `BT /F1 12 Tf 50 750 Td ${lines.map((l, i) => `${i ? '0 -16 Td ' : ''}(${l.replace(/[()\\]/g, '')}) Tj`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const EMPTY_PDF = makePdf([]); // mətnsiz səhifə = skan kimi
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('scan-image-bytes'),
]);

describe('pdf text extraction', () => {
  it('reads real text from a PDF and does not call it scanned', async () => {
    const pdf = await extractPdfText(
      makePdf(['Invoice AA 0001234', 'Total 118.00 AZN seller buyer date']),
    );
    expect(pdf.text).toContain('Invoice AA 0001234');
    expect(pdf.text).toContain('Total 118.00 AZN');
    expect(pdf.pages).toHaveLength(1);
    expect(looksScanned(pdf)).toBe(false);
  });
  it('an image-only/empty PDF looks scanned; garbage throws', async () => {
    expect(looksScanned(await extractPdfText(EMPTY_PDF))).toBe(true);
    await expect(extractPdfText(Buffer.from('%PDF-1.4 not really'))).rejects.toThrow();
  });
});

describe('HttpModelServing validates the contract (§13)', () => {
  const mk = (body: unknown, status = 200) =>
    new HttpModelServing({
      baseUrl: 'http://m',
      fetchImpl: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch,
    });
  const good = {
    invoice: {
      number: 'AA 1',
      issueDate: '2030-05-01',
      currency: 'AZN',
      seller: { name: 'S', voen: '1234567891' },
      buyer: { name: 'B', voen: null },
      lines: [
        {
          description: 'x',
          qty: '1',
          unitPrice: '10.00',
          vatPercent: '18',
          net: '10.00',
          vat: '1.80',
        },
      ],
    },
    confidence: { number: 0.99 },
    overallConfidence: 0.95,
    model: 'extract-1',
  };
  it('accepts a conforming response and rejects float amounts, bad dates, missing lines and out-of-range confidences', async () => {
    expect((await mk(good).extractInvoice('t')).invoice.number).toBe('AA 1');
    const bad = (patch: (g: typeof good) => unknown) =>
      mk(patch(structuredClone(good))).extractInvoice('t');
    await expect(
      bad((g) => ({
        ...g,
        invoice: { ...g.invoice, lines: [{ ...g.invoice.lines[0], net: 10.5 }] },
      })),
    ).rejects.toBeInstanceOf(ModelResponseError);
    await expect(
      bad((g) => ({ ...g, invoice: { ...g.invoice, issueDate: '01.05.2030' } })),
    ).rejects.toBeInstanceOf(ModelResponseError);
    await expect(
      bad((g) => ({ ...g, invoice: { ...g.invoice, lines: [] } })),
    ).rejects.toBeInstanceOf(ModelResponseError);
    await expect(bad((g) => ({ ...g, overallConfidence: 1.5 }))).rejects.toBeInstanceOf(
      ModelResponseError,
    );
    await expect(bad((g) => ({ ...g, confidence: { number: -1 } }))).rejects.toBeInstanceOf(
      ModelResponseError,
    );
    await expect(mk({}, 503).extractInvoice('t')).rejects.toBeInstanceOf(UpstreamError);
  });
  it('validates OCR and account-classification responses', async () => {
    expect((await mk({ text: 'hi', model: 'ocr-1' }).ocr(Buffer.from('x'), 'image/png')).text).toBe(
      'hi',
    );
    await expect(
      mk({ text: 5, model: 'm' }).ocr(Buffer.from('x'), 'image/png'),
    ).rejects.toBeInstanceOf(ModelResponseError);
    expect(
      (
        await mk({ accountCode: '731', confidence: 0.9, model: 'c-1' }).classifyAccount({
          description: 'd',
          direction: 'purchase',
          standard: 'MMUS',
        })
      ).accountCode,
    ).toBe('731');
    await expect(
      mk({ accountCode: 'DROP', confidence: 0.9, model: 'c' }).classifyAccount({
        description: 'd',
        direction: 'purchase',
        standard: 'MMUS',
      }),
    ).rejects.toBeInstanceOf(ModelResponseError);
  });
});

describe('resolveRateCode', () => {
  const rates = [
    taxRate({
      id: 'a',
      taxType: 'VAT',
      code: 'STANDARD',
      ratePercent: '18',
      validFrom: '2001-01-01',
      validTo: '2030-06-30',
    }),
    taxRate({
      id: 'b',
      taxType: 'VAT',
      code: 'STANDARD',
      ratePercent: '20',
      validFrom: '2030-07-01',
    }),
    taxRate({
      id: 'z',
      taxType: 'VAT',
      code: 'ZERO',
      ratePercent: '0',
      validFrom: '2001-01-01',
      treatment: 'zero_rated',
    }),
    taxRate({
      id: 'e',
      taxType: 'VAT',
      code: 'EXEMPT',
      ratePercent: '0',
      validFrom: '2001-01-01',
      treatment: 'exempt',
    }),
  ];
  it('maps a percent to the code in force on the date, honours explicit codes, and never guesses', () => {
    expect(resolveRateCode({ vatPercent: '18' }, rates, '2030-06-30')).toBe('STANDARD');
    expect(resolveRateCode({ vatPercent: '18' }, rates, '2030-07-01')).toBe('UNRESOLVED'); // 18% artıq yoxdur
    expect(resolveRateCode({ vatPercent: '20' }, rates, '2030-07-01')).toBe('STANDARD');
    expect(resolveRateCode({ vatPercent: '0' }, rates, '2030-07-01')).toBe('ZERO'); // yalnız zero_rated; azadolma ayrıca
    expect(resolveRateCode({ vatRateCode: 'EXEMPT' }, rates, '2030-07-01')).toBe('EXEMPT');
    expect(resolveRateCode({ vatRateCode: 'NOPE', vatPercent: '7' }, rates, '2030-07-01')).toBe(
      'UNRESOLVED',
    );
    expect(resolveRateCode({}, rates, '2030-07-01')).toBe('UNRESOLVED');
  });
});

// ------------------------------------------------------------------ end to end
const COMPANY_VOEN_PLACEHOLDER = 'COMPANY';
class FakeModels implements ModelServing {
  ocrText = 'OCR RESULT TEXT with enough characters to be a document';
  ocrCalls = 0;
  down = false;
  badContract = false;
  extracted: ExtractedInvoice = {
    invoice: {
      number: 'AI-1',
      issueDate: '2030-05-01',
      currency: 'AZN',
      seller: { name: 'Təchizatçı MMC', voen: '1234567891' },
      buyer: { name: 'Alpha MMC', voen: COMPANY_VOEN_PLACEHOLDER },
      lines: [
        {
          description: 'Ofis ləvazimatları',
          qty: '2',
          unitPrice: '25.00',
          vatPercent: '18',
          net: '50.00',
          vat: '9.00',
        },
        {
          description: 'Nəqliyyat',
          qty: '1',
          unitPrice: '100.00',
          vatPercent: '18',
          net: '100.00',
          vat: '18.00',
        },
      ],
      net: '150.00',
      vat: '27.00',
      gross: '177.00',
    },
    confidence: { number: 0.99, issueDate: 0.98, 'lines.1.net': 0.6 },
    overallConfidence: 0.9,
    model: 'extract-9.1',
  };
  account = new Map<string, { code: string; confidence: number }>();
  async ocr() {
    this.ocrCalls++;
    if (this.down) throw new UpstreamError('ocr down');
    return {
      text: this.ocrText,
      pages: 1,
      confidence: 0.9,
      model: 'ocr-3',
      alternatives: undefined,
    } as never;
  }
  async extractInvoice(): Promise<ExtractedInvoice> {
    if (this.down) throw new UpstreamError('down');
    if (this.badContract) throw new ModelResponseError('bad contract');
    return structuredClone(this.extracted);
  }
  async classifyAccount(req: { description: string }) {
    const a = this.account.get(req.description) ?? { code: '731', confidence: 0.92 };
    return { accountCode: a.code, confidence: a.confidence, model: 'classify-2', alternatives: [] };
  }
}

let env: TestEnv;
let token: string;
let other: string;
const models = new FakeModels();
const get = (t: string, url: string) =>
  env.app.inject({ method: 'GET', url, headers: env.bearer(t) });

beforeAll(async () => {
  env = await createTestEnv(
    { loginRateLimitPerMinute: 1000, extractionReviewThreshold: 0.85 },
    { models },
  );
  const company = (await env.repos.companies.findById(env.companyA))!;
  models.extracted.invoice.buyer.voen = company.voen;
  token = (await env.login(env.admin.email)).accessToken;
  other = (await env.login(env.otherCompanyAdmin.email)).accessToken;
  await env.repos.taxRates.create(
    taxRate({
      id: crypto.randomUUID(),
      taxType: 'VAT',
      code: 'STANDARD',
      ratePercent: '18',
      validFrom: '2001-01-01',
    }),
  );
});
afterAll(() => env.close());

async function upload(content: Buffer, name: string, type: string, tok = token) {
  const { payload, headers } = multipart({ name, content, type });
  const res = await env.app.inject({
    method: 'POST',
    url: '/api/v1/invoices/upload',
    payload,
    headers: { ...env.bearer(tok), ...headers },
  });
  expect(res.statusCode, res.body).toBe(202);
  await env.worker.drain();
  return res.json() as { fileId: string; fileVersionId: string };
}
const invoices = async (tok = token) =>
  (await get(tok, '/api/v1/invoices?limit=100')).json().items as Array<{
    id: string;
    number: string;
    status: string;
  }>;
const detail = async (id: string, tok = token) => (await get(tok, `/api/v1/invoices/${id}`)).json();
const lastImport = async () =>
  (
    await env.db.query<{ status: string; template_version: string; error: string | null }>(
      `SELECT status, template_version, error FROM import_jobs ORDER BY created_at DESC LIMIT 1`,
    )
  )[0]!;

describe('text PDF → extract_invoice → invoice', () => {
  it('extracts text directly (no OCR), creates the invoice with confidences and model version, and suggests (never sets) accounts', async () => {
    models.ocrCalls = 0;
    const { fileVersionId } = await upload(
      makePdf([
        'Invoice AI-1 from Techizatci seller',
        'Total 177.00 AZN VAT 27.00 buyer Alpha date 2030-05-01',
      ]),
      'inv.pdf',
      'application/pdf',
    );
    expect(models.ocrCalls).toBe(0);
    const ex = (await env.repos.files.findExtraction(env.companyA, fileVersionId))!;
    expect(ex).toMatchObject({ status: 'ready', detectedKind: 'pdf' });
    expect(ex.text).toContain('Invoice AI-1');
    expect(ex.layoutJson).toMatchObject({ method: 'text' });

    const inv = (await invoices()).find((i) => i.number === 'AI-1')!;
    const d = await detail(inv.id);
    expect(d).toMatchObject({
      direction: 'purchase',
      aiModelVersion: 'extract-9.1',
      extractionConfidence: '0.900',
      net: '150.00',
      gross: '177.00',
    });
    expect(d.lines.map((l: { vatRateCode: string }) => l.vatRateCode)).toEqual([
      'STANDARD',
      'STANDARD',
    ]);
    expect(
      d.lines.every(
        (l: {
          accountSuggestion: string;
          accountFinal: string | null;
          accountSuggestionConfidence: string;
        }) =>
          l.accountSuggestion === '731' &&
          l.accountFinal === null &&
          l.accountSuggestionConfidence === '0.920',
      ),
    ).toBe(true);
    // 0.6 < 0.85: sahə yoxlama tələb edir → needs_review (xətasız olsa belə)
    expect(d.lowConfidenceFields).toEqual(['lines.1.net']);
    expect(d.status).toBe('needs_review');
    expect(d.issues.map((i: { code: string }) => i.code)).toEqual(['LOW_CONFIDENCE']);
    expect(await lastImport()).toMatchObject({ status: 'done', template_version: 'ai-extract' });
  });

  it('a human correction clears the flag, is recorded for training, and the invoice can then validate', async () => {
    const inv = (await invoices()).find((i) => i.number === 'AI-1')!;
    const d = await detail(inv.id);
    const line = d.lines[1];
    const patch = await env.app.inject({
      method: 'PATCH',
      url: `/api/v1/invoices/${inv.id}`,
      headers: env.bearer(token),
      payload: {
        lines: [
          { id: line.id, net: '100.00', accountFinal: '201' },
          { id: d.lines[0].id, accountFinal: '731' },
        ],
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().lowConfidenceFields).toEqual([]);
    expect(patch.json().lines[1].accountFinal).toBe('201');
    const fb = await env.db.query<{
      kind: string;
      before: { accountSuggestion: string; modelVersion: string };
      after: { accountFinal: string };
    }>(
      `SELECT kind, before, after FROM feedback_events WHERE invoice_line_id IN ($1,$2) ORDER BY kind`,
      [line.id, d.lines[0].id],
    );
    expect(fb.map((f) => f.kind).sort()).toEqual(['approval_decision', 'correction']);
    expect(fb.find((f) => f.kind === 'correction')).toMatchObject({
      before: { accountSuggestion: '731', modelVersion: 'extract-9.1' },
      after: { accountFinal: '201' },
    });
    const validated = await env.app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${inv.id}/validate`,
      headers: env.bearer(token),
      payload: {},
    });
    expect(validated.json().status).toBe('validated');
  });
});

describe('scanned documents → OCR → extract_invoice', () => {
  it('a scanned PDF and an image both go through OCR; failures are recorded, not retried forever', async () => {
    models.extracted.invoice.number = 'SCAN-1';
    models.extracted.confidence = { number: 0.99 };
    models.extracted.overallConfidence = 0.97;
    models.ocrCalls = 0;
    const { fileVersionId } = await upload(EMPTY_PDF, 'scan.pdf', 'application/pdf');
    expect(models.ocrCalls).toBe(1);
    expect(
      (await env.repos.files.findExtraction(env.companyA, fileVersionId))!.layoutJson,
    ).toMatchObject({ method: 'ocr', model: 'ocr-3' });
    const scanned = (await invoices()).find((i) => i.number === 'SCAN-1')!;
    expect(scanned.status).toBe('validated'); // yüksək etibarlılıq + xətasız

    models.extracted.invoice.number = 'IMG-1';
    await upload(PNG, 'photo.png', 'image/png');
    expect((await invoices()).some((i) => i.number === 'IMG-1')).toBe(true);
    expect(models.ocrCalls).toBe(2);
  });

  it('OCR model not configured → extraction failed with a clear permanent error and import_jobs.failed', async () => {
    const bare = await createTestEnv({ loginRateLimitPerMinute: 1000 });
    try {
      const t = (await bare.login(bare.admin.email)).accessToken;
      const { payload, headers } = multipart({
        name: 'photo.png',
        content: PNG,
        type: 'image/png',
      });
      const r = await bare.app.inject({
        method: 'POST',
        url: '/api/v1/invoices/upload',
        payload,
        headers: { ...bare.bearer(t), ...headers },
      });
      const { fileVersionId } = r.json();
      await bare.worker.drain();
      const ex = (await bare.repos.files.findExtraction(bare.companyA, fileVersionId))!;
      expect(ex).toMatchObject({ status: 'failed' });
      expect(ex.error).toMatch(/OCR_UNAVAILABLE/);
      const [job] = await bare.db.query<{ status: string; attempts: number }>(
        `SELECT status, attempts FROM jobs WHERE idempotency_key = $1`,
        [`extract:${fileVersionId}`],
      );
      expect(job).toMatchObject({ status: 'succeeded', attempts: 1 }); // təkrar cəhd yoxdur
      expect(
        (
          await bare.db.query<{ status: string }>(
            `SELECT status FROM import_jobs ORDER BY created_at DESC LIMIT 1`,
          )
        )[0]!.status,
      ).toBe('failed');
    } finally {
      await bare.close();
    }
  });
});

describe('model failures', () => {
  it('model outage → the job is retried with backoff (nothing half-created); recovery completes the import', async () => {
    models.extracted.invoice.number = 'RETRY-1';
    models.down = true;
    const before = (await invoices()).length;
    let ids: { fileVersionId: string };
    try {
      ids = await upload(
        makePdf([
          'Invoice RETRY-1 text content long enough for the check',
          'more words so that it is not considered scanned at all',
        ]),
        'r.pdf',
        'application/pdf',
      );
    } finally {
      models.down = false;
    }
    expect((await invoices()).length).toBe(before);
    const [job] = await env.db.query<{ status: string; attempts: number; max_attempts: number }>(
      `SELECT status, attempts, max_attempts FROM jobs WHERE idempotency_key = $1`,
      [`invoice-parse:${ids.fileVersionId}`],
    );
    expect(job).toMatchObject({ status: 'queued', attempts: 1, max_attempts: 8 });
    await env.db.query(
      `UPDATE jobs SET run_at = NOW() - interval '1 second' WHERE status = 'queued'`,
    );
    await env.worker.drain();
    expect((await invoices()).some((i) => i.number === 'RETRY-1')).toBe(true);
    expect((await env.db.query(`SELECT 1 FROM import_jobs WHERE status = 'running'`)).length).toBe(
      0,
    );
  });

  it('a model answer that breaks the contract is NOT retried: import_jobs.failed with the reason, no invoice', async () => {
    models.badContract = true;
    models.extracted.invoice.number = 'BAD-1';
    try {
      await upload(
        makePdf([
          'Invoice BAD-1 body text with enough characters to pass',
          'second line of regular text for the document body',
        ]),
        'b.pdf',
        'application/pdf',
      );
    } finally {
      models.badContract = false;
    }
    expect((await invoices()).some((i) => i.number === 'BAD-1')).toBe(false);
    expect(await lastImport()).toMatchObject({ status: 'failed', template_version: 'ai-extract' });
    expect((await lastImport()).error).toMatch(/AI extraction failed/);
  });

  it('account-suggestion failures never break the import; a suggestion outside the company chart is discarded', async () => {
    const chart = await env.db.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (company_id, name) VALUES ($1,'Test chart') RETURNING id`,
      [env.companyA],
    );
    await env.db.query(
      `INSERT INTO accounts (company_id, chart_id, code, name_az, type) VALUES ($1,$2,'731','Xərclər','expense')`,
      [env.companyA, chart[0]!.id],
    );
    await env.db.query(`UPDATE companies SET chart_of_accounts_id = $2 WHERE id = $1`, [
      env.companyA,
      chart[0]!.id,
    ]);
    models.extracted.invoice.number = 'CHART-1';
    models.extracted.invoice.lines = [
      {
        description: 'inchart',
        qty: '1',
        unitPrice: '10.00',
        vatPercent: '18',
        net: '10.00',
        vat: '1.80',
      },
      {
        description: 'offchart',
        qty: '1',
        unitPrice: '10.00',
        vatPercent: '18',
        net: '10.00',
        vat: '1.80',
      },
    ];
    models.extracted.invoice.net = '20.00';
    models.extracted.invoice.vat = '3.60';
    models.extracted.invoice.gross = '23.60';
    models.account.set('offchart', { code: '999', confidence: 0.99 });
    await upload(
      makePdf([
        'Invoice CHART-1 some body text for the document',
        'another body line to make the page text long enough',
      ]),
      'c.pdf',
      'application/pdf',
    );
    const inv = (await invoices()).find((i) => i.number === 'CHART-1')!;
    const d = await detail(inv.id);
    expect(d.lines.map((l: { accountSuggestion: string | null }) => l.accountSuggestion)).toEqual([
      '731',
      null,
    ]);
  });

  it('an unresolvable VAT percent is flagged (UNRESOLVED rate → issue + needs_review) instead of being guessed', async () => {
    models.account.clear();
    models.extracted.invoice.number = 'RATE-1';
    models.extracted.invoice.lines = [
      {
        description: 'odd',
        qty: '1',
        unitPrice: '100.00',
        vatPercent: '7',
        net: '100.00',
        vat: '7.00',
      },
    ];
    models.extracted.invoice.net = '100.00';
    models.extracted.invoice.vat = '7.00';
    models.extracted.invoice.gross = '107.00';
    await upload(
      makePdf([
        'Invoice RATE-1 body text of the invoice document',
        'second row of text so extraction is not scanned at all',
      ]),
      'd.pdf',
      'application/pdf',
    );
    const d = await detail((await invoices()).find((i) => i.number === 'RATE-1')!.id);
    expect(d.lines[0].vatRateCode).toBe('UNRESOLVED');
    expect(d.lowConfidenceFields).toContain('lines.0.vatRateCode');
    expect(d.issues.map((i: { code: string }) => i.code)).toEqual(
      expect.arrayContaining(['RATE_NOT_FOUND', 'LOW_CONFIDENCE']),
    );
    expect(d.status).toBe('needs_review');
  });
});

describe('isolation', () => {
  it('AI-created invoices belong to the uploader’s company only', async () => {
    expect((await invoices(other)).some((i) => ['AI-1', 'SCAN-1'].includes(i.number))).toBe(false);
  });
});
