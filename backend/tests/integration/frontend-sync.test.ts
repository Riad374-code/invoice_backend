import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApproval } from '../../src/domain/index.js';
import { CSV_TEXT, multipart } from '../helpers/multipart.js';
import { createTestEnv, type TestEnv } from '../helpers/app.js';

let env: TestEnv;
let admin: string;
let other: string;
const call = (m: 'GET' | 'POST', t: string, url: string) =>
  env.app.inject({ method: m, url, headers: env.bearer(t) });

beforeAll(async () => {
  env = await createTestEnv({ loginRateLimitPerMinute: 1000 });
  admin = (await env.login(env.admin.email)).accessToken;
  other = (await env.login(env.otherCompanyAdmin.email)).accessToken;
});
afterAll(() => env.close());

async function uploadFile(): Promise<string> {
  const { payload, headers } = multipart({ name: 'src.csv', content: CSV_TEXT, type: 'text/csv' });
  const res = await env.app.inject({
    method: 'POST',
    url: '/api/v1/files',
    payload,
    headers: { ...env.bearer(admin), ...headers },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

describe('endpoints the frontend asked for', () => {
  it('GET /approvals/:id is tenant-scoped', async () => {
    const a = await env.repos.approvals.create(
      newApproval({
        companyId: env.companyA,
        kind: 'generic_review',
        resourceRef: 'x:1',
        payload: {},
        requesterId: env.admin.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    );
    expect((await call('GET', admin, `/api/v1/approvals/${a.id}`)).json().id).toBe(a.id);
    expect((await call('GET', other, `/api/v1/approvals/${a.id}`)).statusCode).toBe(404);
  });

  it('POST /files/:id/restore undoes archive, idempotently, and audits', async () => {
    const id = await uploadFile();
    expect(
      (await call('POST', admin, `/api/v1/files/${id}/archive`)).json().archivedAt,
    ).not.toBeNull();
    const r1 = await call('POST', admin, `/api/v1/files/${id}/restore`);
    expect(r1.statusCode).toBe(200);
    expect(r1.json().archivedAt).toBeNull();
    expect((await call('POST', admin, `/api/v1/files/${id}/restore`)).json().archivedAt).toBeNull();
    expect((await call('POST', other, `/api/v1/files/${id}/restore`)).statusCode).toBe(404);
    expect((await env.repos.audit.listByCompany(env.companyA, 100)).map((e) => e.action)).toContain(
      'file.restore',
    );
  });

  it('GET /invoices/:id/source streams the original, 404 when there is none', async () => {
    const fileId = await uploadFile();
    const base = {
      companyId: env.companyA,
      direction: 'purchase' as const,
      issueDate: '2026-01-10',
      counterpartyId: null,
      currency: 'AZN',
      net: '10.00',
      vat: '1.80',
      gross: '11.80',
      status: 'needs_review' as const,
      extractionConfidence: null,
      templateVersion: null,
      lines: [],
    };
    const withSrc = await env.repos.invoices.create({
      ...base,
      number: 'SRC-1',
      sourceFileId: fileId,
    });
    const noSrc = await env.repos.invoices.create({ ...base, number: 'SRC-2', sourceFileId: null });
    const ok = await call('GET', admin, `/api/v1/invoices/${withSrc}/source`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/csv');
    expect(ok.body).toBe(CSV_TEXT);
    expect((await call('GET', admin, `/api/v1/invoices/${noSrc}/source`)).statusCode).toBe(404);
    expect((await call('GET', other, `/api/v1/invoices/${withSrc}/source`)).statusCode).toBe(404);
  });

  it('GET /news/sources works for a plain news reader (no platform permission)', async () => {
    const viewer = (await env.login(env.viewer.email)).accessToken;
    const res = await call('GET', viewer, '/api/v1/news/sources');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    expect((await call('GET', viewer, '/api/v1/admin/sources')).statusCode).toBe(403);
  });
});
