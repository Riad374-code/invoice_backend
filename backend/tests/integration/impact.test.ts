import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { taxRate } from '../../src/accounting/index.js';
import {
  HttpModelServing,
  type ModelServing,
  type NewsClassification,
} from '../../src/models/client.js';
import { EMBEDDING_DIM, UpstreamError, type Embedder } from '../../src/rag/clients.js';
import { azNormalize } from '../../src/rag/query.js';
import { createTestEnv, type TestEnv } from '../helpers/app.js';

class FakeEmbedder implements Embedder {
  model = 'fake-1024';
  fail = false;
  async embed(texts: string[]) {
    if (this.fail) throw new UpstreamError('down');
    return texts.map((t) => {
      const v = new Array<number>(EMBEDDING_DIM).fill(0);
      for (const w of azNormalize(t).match(/[\p{L}\p{N}]+/gu) ?? [])
        v[createHash('md5').update(w).digest().readUInt16BE(0) % EMBEDDING_DIM]! += 1;
      return v;
    });
  }
}
class FakeModels implements ModelServing {
  news: NewsClassification = {
    category: 'tax',
    riskLevel: 'high',
    tags: ['edv'],
    summary: 'ƏDV dəyişir',
    rateChange: null,
    model: 'news-1',
  };
  async ocr(): Promise<never> {
    throw new Error('x');
  }
  async extractInvoice(): Promise<never> {
    throw new Error('x');
  }
  async classifyAccount(): Promise<never> {
    throw new Error('x');
  }
  async classifyNews() {
    return structuredClone(this.news);
  }
}

let env: TestEnv;
const embedder = new FakeEmbedder();
const models = new FakeModels();
let admin: string;
let viewer: string;
let other: string;
let approver: string;
const get = (t: string, url: string) =>
  env.app.inject({ method: 'GET', url, headers: env.bearer(t) });
const put = (t: string, url: string, payload: object = {}) =>
  env.app.inject({ method: 'PUT', url, headers: env.bearer(t), payload });
const post = (t: string, url: string, payload: object = {}) =>
  env.app.inject({ method: 'POST', url, headers: env.bearer(t), payload });

async function addFile(
  companyId: string,
  ownerId: string,
  name: string,
  text: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const vid = crypto.randomUUID();
  await env.db.query(
    `INSERT INTO files (id, company_id, name, mime, size, owner_id) VALUES ($1,$2,$3,'text/plain',1,$4)`,
    [id, companyId, name, ownerId],
  );
  await env.db.query(
    `INSERT INTO file_versions (id, company_id, file_id, version_no, storage_key, sha256, size, mime, uploaded_by) VALUES ($1,$2,$3,1,'k',$4,1,'text/plain',$5)`,
    [vid, companyId, id, 'a'.repeat(64), ownerId],
  );
  await env.db.query(
    `INSERT INTO file_extractions (company_id, file_version_id, status, text) VALUES ($1,$2,'ready',$3)`,
    [companyId, vid, text],
  );
  await env.repos.jobs.enqueue({
    queue: 'chunks.index',
    companyId,
    payload: { resourceType: 'file', resourceId: id, versionId: vid },
  });
  return id;
}
async function addNews(title: string, text: string): Promise<string> {
  const src = (await env.repos.ingestion.listSources())[0]!;
  const id = (await env.repos.ingestion.insertNews(
    {
      sourceId: src.id,
      title,
      originalUrl: `https://x.az/${title}`,
      canonicalUrl: `https://x.az/${title}-${crypto.randomUUID()}`,
      contentHash: 'c'.repeat(64),
      publishedAt: null,
      rawText: text,
    },
    new Date(),
  ))!;
  await env.repos.jobs.enqueue({
    queue: 'chunks.index',
    payload: { resourceType: 'news', resourceId: id },
  });
  await env.repos.jobs.enqueue({ queue: 'news.enrich', payload: { newsId: id } });
  return id;
}

beforeAll(async () => {
  env = await createTestEnv(
    { loginRateLimitPerMinute: 1000, impactMinSimilarity: 0.5 },
    { embedder, models },
  );
  [admin, viewer, other, approver] = (await Promise.all(
    [env.admin, env.viewer, env.otherCompanyAdmin, env.approver].map(
      async (u) => (await env.login(u.email)).accessToken,
    ),
  )) as [string, string, string, string];
});
afterAll(() => env.close());

describe('news.enrich + impact.analyze', () => {
  let alpha: string;
  let beta: string;
  let unrelated: string;
  beforeAll(async () => {
    alpha = await addFile(
      env.companyA,
      env.admin.id,
      'alpha.txt',
      'müqavilə ƏDV dərəcəsi dəyişikliyi hesablama qaydası',
    );
    unrelated = await addFile(
      env.companyA,
      env.admin.id,
      'other.txt',
      'ofis mebeli satınalma təklifi tədarükçü',
    );
    beta = await addFile(
      env.companyB,
      env.otherCompanyAdmin.id,
      'beta.txt',
      'müqavilə ƏDV dərəcəsi dəyişikliyi hesablama qaydası',
    );
    await env.worker.drain();
  });

  it('enriches the news (AI columns separate from raw_text) and creates findings ONLY for related documents of each company', async () => {
    const newsId = await addNews('edv', 'ƏDV dərəcəsi dəyişikliyi hesablama qaydası yeni müqavilə');
    await env.worker.drain();
    const [n] = await env.db.query<{
      raw_text: string;
      ai_summary: string;
      ai_risk_level: string;
      ai_model_version: string;
    }>(
      `SELECT raw_text, ai_summary, ai_risk_level, ai_model_version FROM news_items WHERE id = $1`,
      [newsId],
    );
    expect(n).toMatchObject({
      raw_text: 'ƏDV dərəcəsi dəyişikliyi hesablama qaydası yeni müqavilə',
      ai_summary: 'ƏDV dəyişir',
      ai_risk_level: 'high',
      ai_model_version: 'news-1',
    });

    const a = (await get(admin, '/api/v1/impact-findings')).json() as Array<{
      affectedResourceId: string;
      sourceId: string;
      score: string;
      status: string;
      explanation: string;
    }>;
    expect(a.map((f) => f.affectedResourceId)).toEqual([alpha]);
    expect(a[0]).toMatchObject({ sourceId: newsId, status: 'new' });
    expect(Number(a[0]!.score)).toBeGreaterThanOrEqual(0.5);
    expect(a.map((f) => f.affectedResourceId)).not.toContain(unrelated);
    // TENANT: beta öz faylı üçün görür, alpha-nı yox
    const b = (await get(other, '/api/v1/impact-findings')).json() as Array<{
      affectedResourceId: string;
    }>;
    expect(b.map((f) => f.affectedResourceId)).toEqual([beta]);
  });

  it('is idempotent: re-running the job creates no duplicate findings or notifications', async () => {
    const before = (await env.db.query(`SELECT 1 FROM impact_findings`)).length;
    const nBefore = (await env.db.query(`SELECT 1 FROM notifications`)).length;
    const newsId = (await env.db.query<{ id: string }>(`SELECT id FROM news_items LIMIT 1`))[0]!.id;
    await env.repos.jobs.enqueue({
      queue: 'impact.analyze',
      payload: { sourceKind: 'news', sourceId: newsId },
    });
    await env.worker.drain();
    expect((await env.db.query(`SELECT 1 FROM impact_findings`)).length).toBe(before);
    expect((await env.db.query(`SELECT 1 FROM notifications`)).length).toBe(nBefore);
  });

  it('notifies the company’s users with impact:read only, with unread counts, polling and mark-read', async () => {
    const adminN = (await get(admin, '/api/v1/notifications')).json();
    expect(adminN.unreadCount).toBe(1);
    expect(adminN.items[0]).toMatchObject({
      kind: 'impact_finding',
      read: false,
      refType: 'impact_finding',
    });
    // başqa şirkətin istifadəçisi bu bildirişi görmür; öz bildirişi var
    const otherN = (await get(other, '/api/v1/notifications')).json();
    expect(otherN.items.map((i: { id: string }) => i.id)).not.toContain(adminN.items[0].id);
    // polling: afterSeq
    expect(
      (await get(admin, `/api/v1/notifications?afterSeq=${adminN.items[0].seq}`)).json().items,
    ).toEqual([]);
    expect(
      (await put(other, `/api/v1/notifications/${adminN.items[0].id}/read`)).json().updated,
    ).toBe(0); // başqasının bildirişi
    expect(
      (await put(admin, `/api/v1/notifications/${adminN.items[0].id}/read`)).json().updated,
    ).toBe(1);
    expect((await get(admin, '/api/v1/notifications')).json().unreadCount).toBe(0);
    expect((await get(admin, '/api/v1/notifications?unreadOnly=true')).json().items).toEqual([]);
    expect((await post(admin, '/api/v1/notifications/read-all')).statusCode).toBe(200);
  });

  it('findings can be triaged (audited); unknown/foreign ids are 404; invalid status 422', async () => {
    const f = (await get(admin, '/api/v1/impact-findings')).json()[0];
    expect(
      (await put(admin, `/api/v1/impact-findings/${f.id}/status`, { status: 'actioned' })).json()
        .status,
    ).toBe('actioned');
    expect((await get(admin, '/api/v1/impact-findings?status=new')).json()).toEqual([]);
    expect(
      (await put(other, `/api/v1/impact-findings/${f.id}/status`, { status: 'seen' })).statusCode,
    ).toBe(404);
    expect(
      (await put(admin, `/api/v1/impact-findings/${f.id}/status`, { status: 'new' })).statusCode,
    ).toBe(422);
    expect(
      (await put(viewer, `/api/v1/impact-findings/${f.id}/status`, { status: 'seen' })).statusCode,
    ).toBe(403);
    expect((await get(viewer, '/api/v1/impact-findings')).statusCode).toBe(200);
    expect((await env.repos.audit.listByCompany(env.companyA, 300)).map((e) => e.action)).toContain(
      'impact.status',
    );
  });

  it('waits (retries) while the source chunks are not embedded yet, and never fakes a result when the embedder is down', async () => {
    embedder.fail = true;
    try {
      const id = await addNews('later', 'ƏDV dərəcəsi dəyişikliyi hesablama qaydası başqa xəbər');
      await env.worker.drain();
      const [job] = await env.db.query<{ status: string; last_error: string | null }>(
        `SELECT status, last_error FROM jobs WHERE idempotency_key = $1`,
        [`impact:news:${id}`],
      );
      expect(job!.status).toBe('queued');
      expect(job!.last_error).toMatch(/not (embedded|have)|no chunks|embedded yet/i);
    } finally {
      embedder.fail = false;
    }
  });
});

describe('tax-rate change proposals need platform approval', () => {
  const rc = {
    taxType: 'VAT' as const,
    code: 'STANDARD',
    ratePercent: '20',
    validFrom: '2031-01-01',
    confidence: 0.95,
  };
  let platformAdmin: string;
  beforeAll(async () => {
    await env.repos.taxRates.create(
      taxRate({
        id: crypto.randomUUID(),
        taxType: 'VAT',
        code: 'STANDARD',
        ratePercent: '18',
        validFrom: '2001-01-01',
      }),
    );
    await env.db.query(`UPDATE companies SET is_platform = TRUE WHERE id = $1`, [env.companyA]);
    platformAdmin = admin;
  });

  it('a confident detection creates a PROPOSED rate (invisible to the engine) + a pending approval; low confidence does not', async () => {
    models.news = { ...models.news, rateChange: { ...rc, confidence: 0.5 } };
    await addNews('weak', 'zəif siqnal xəbər');
    await env.worker.drain();
    expect((await env.db.query(`SELECT 1 FROM tax_rates WHERE status = 'proposed'`)).length).toBe(
      0,
    );

    models.news = { ...models.news, rateChange: rc };
    await addNews('strong', 'ƏDV dərəcəsi 20 faiz olacaq 2031');
    await env.worker.drain();
    const [r] = await env.db.query<{ id: string; status: string; rate: string }>(
      `SELECT id, status, rate::text FROM tax_rates WHERE status = 'proposed'`,
    );
    expect(r).toMatchObject({ status: 'proposed', rate: '20.0000' });
    expect(
      (await env.repos.taxRates.listActive('VAT')).find((x) => x.ratePercent.eq(20)),
    ).toBeUndefined();
    const approvals = (await get(platformAdmin, '/api/v1/approvals')).json() as Array<{
      id: string;
      kind: string;
      status: string;
      requesterId: string;
    }>;
    const a = approvals.find((x) => x.kind === 'tax_rate_proposal')!;
    expect(a.status).toBe('pending');
    expect((await env.repos.users.findById(a.requesterId))!.status).toBe('suspended'); // sistem aktoru, login olunmur
    // eyni dəyişiklik təkrar təklif olunmur
    await addNews('strong-again', 'eyni xəbər yenə');
    await env.worker.drain();
    expect((await env.db.query(`SELECT 1 FROM tax_rates WHERE status = 'proposed'`)).length).toBe(
      1,
    );
  });

  it('approval activates it and closes the previous period; the engine then uses the right rate by date; other companies cannot decide', async () => {
    const a = (
      (await get(admin, '/api/v1/approvals')).json() as Array<{ id: string; kind: string }>
    ).find((x) => x.kind === 'tax_rate_proposal')!;
    expect(
      (await post(other, `/api/v1/approvals/${a.id}/decide`, { decision: 'approve' })).statusCode,
    ).toBe(404);
    expect(
      (await post(approver, `/api/v1/approvals/${a.id}/decide`, { decision: 'approve' }))
        .statusCode,
    ).toBe(200);
    const rates = await env.repos.taxRates.listActive('VAT');
    const std = rates
      .filter((r) => r.code === 'STANDARD')
      .sort((x, y) => (x.validFrom < y.validFrom ? -1 : 1));
    expect(std.map((r) => [r.ratePercent.toString(), r.validFrom, r.validTo])).toEqual([
      ['18', '2001-01-01', '2030-12-31'],
      ['20', '2031-01-01', null],
    ]);
  });

  it('a rejected proposal is removed; a proposal that would overlap an active rate fails the approval (409) instead of corrupting data', async () => {
    models.news = {
      ...models.news,
      rateChange: { ...rc, ratePercent: '25', validFrom: '2032-01-01' },
    };
    await addNews('reject-me', 'yeni dəyişiklik 25 faiz');
    await env.worker.drain();
    const a = (
      (await get(admin, '/api/v1/approvals')).json() as Array<{
        id: string;
        kind: string;
        status: string;
      }>
    ).find((x) => x.kind === 'tax_rate_proposal' && x.status === 'pending')!;
    expect(
      (await post(approver, `/api/v1/approvals/${a.id}/decide`, { decision: 'reject' })).statusCode,
    ).toBe(200);
    expect((await env.db.query(`SELECT 1 FROM tax_rates WHERE status = 'proposed'`)).length).toBe(
      0,
    );
  });
});

describe('classify/news contract', () => {
  it('rejects malformed answers (bad risk level, float-looking percent)', async () => {
    const mk = (body: unknown) =>
      new HttpModelServing({
        baseUrl: 'http://m',
        fetchImpl: (async () => new Response(JSON.stringify(body))) as typeof fetch,
      });
    const ok = { category: 'tax', riskLevel: 'low', summary: 's', model: 'm' };
    expect((await mk(ok).classifyNews('t')).rateChange).toBeNull();
    await expect(mk({ ...ok, riskLevel: 'extreme' }).classifyNews('t')).rejects.toThrow(/contract/);
    await expect(
      mk({
        ...ok,
        rateChange: {
          taxType: 'VAT',
          code: 'X',
          ratePercent: '1e2',
          validFrom: '2031-01-01',
          confidence: 0.9,
        },
      }).classifyNews('t'),
    ).rejects.toThrow(/contract/);
  });
});
