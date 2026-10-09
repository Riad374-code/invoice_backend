import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobKey } from '../../src/storage/index.js';
import { ScannerUnavailableError } from '../../src/security/antivirus.js';
import { NoopScanner } from '../../src/security/antivirus.js';
import { StorageError } from '../../src/storage/index.js';
import { createTestEnv, type TestEnv } from '../helpers/app.js';
import { CSV_TEXT, PDF_BYTES, PNG_BYTES, multipart } from '../helpers/multipart.js';

let env: TestEnv;
let adminToken: string;
let viewerToken: string;
let otherToken: string;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  env = await createTestEnv({ loginRateLimitPerMinute: 1000, maxUploadBytes: 64 * 1024 });
  adminToken = (await env.login(env.admin.email)).accessToken;
  viewerToken = (await env.login(env.viewer.email)).accessToken;
  otherToken = (await env.login(env.otherCompanyAdmin.email)).accessToken;
});
afterAll(() => env.close());

type Upload = Parameters<typeof multipart>;
const upload = (
  token: string,
  file: Upload[0],
  fields?: Upload[1],
  extraHeaders: Record<string, string> = {},
) => {
  const { payload, headers } = multipart(file, fields);
  return env.app.inject({
    method: 'POST',
    url: '/api/v1/files',
    payload,
    headers: { ...env.bearer(token), ...headers, ...extraHeaders },
  });
};
const get = (token: string, url: string) =>
  env.app.inject({ method: 'GET', url, headers: env.bearer(token) });
const post = (token: string, url: string, payload?: object) =>
  env.app.inject({ method: 'POST', url, headers: env.bearer(token), payload });
const actions = async (companyId = env.companyA) =>
  (await env.repos.audit.listByCompany(companyId, 500)).map((e) => e.action);

async function uploadCsv(name = 'sales.csv', fields?: Record<string, string>, token = adminToken) {
  const res = await upload(token, { name, content: CSV_TEXT, type: 'text/csv' }, fields);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

describe('POST /files', () => {
  it('stores the object in S3 by content hash, records version + extraction, queues the job and audits', async () => {
    const res = await upload(
      adminToken,
      { name: 'sales.csv', content: CSV_TEXT, type: 'text/csv' },
      {
        folder: '2026/Q1',
        tags: 'ƏDV, Q1',
      },
    );
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      name: 'sales.csv',
      mime: 'text/csv',
      size: Buffer.byteLength(CSV_TEXT),
      folder: '/2026/Q1',
      tags: ['ədv', 'q1'],
      ownerId: env.admin.id,
      archivedAt: null,
      extractionStatus: 'pending',
      extraction: { status: 'pending', detectedKind: 'csv', textLength: null },
    });
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({
      versionNo: 1,
      sha256: sha(CSV_TEXT),
      uploadedBy: env.admin.id,
    });

    // DB-də yalnız storage_key; baytlar anbardadır
    const key = blobKey(env.companyA, sha(CSV_TEXT));
    const [row] = await env.db.query<{ storage_key: string }>(
      'SELECT storage_key FROM file_versions WHERE id = $1',
      [body.versions[0].id],
    );
    expect(row?.storage_key).toBe(key);
    expect((await env.storage.get(key)).toString()).toBe(CSV_TEXT);
    expect(env.storage.objects.get(key)?.contentType).toBe('text/csv');

    // iş növbədədir
    const jobs = await env.db.query<{ queue: string; payload: { fileVersionId: string } }>(
      `SELECT queue, payload FROM jobs WHERE idempotency_key = $1`,
      [`extract:${body.versions[0].id}`],
    );
    expect(jobs).toEqual([
      { queue: 'file.extract', payload: { fileVersionId: body.versions[0].id } },
    ]);

    const evt = (await env.repos.audit.listByCompany(env.companyA, 50)).find(
      (e) => e.action === 'file.upload' && e.resourceId === body.id,
    );
    expect(evt).toMatchObject({
      actorId: env.admin.id,
      after: { sha256: sha(CSV_TEXT), tags: ['ədv', 'q1'] },
    });
  });

  it('dedupes identical content per company: one object, two file records', async () => {
    const bytes = 'dedupe,me\n1,2\n';
    const before = env.storage.objects.size;
    const a = await upload(adminToken, { name: 'a.csv', content: bytes });
    const b = await upload(adminToken, { name: 'b.csv', content: bytes }, { folder: '/other' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().id).not.toBe(b.json().id);
    expect(env.storage.objects.size).toBe(before + 1);
    expect(b.json().versions[0].sha256).toBe(a.json().versions[0].sha256);
    const evt = (await env.repos.audit.listByCompany(env.companyA, 20)).find(
      (e) => e.resourceId === b.json().id,
    );
    expect(evt?.after).toMatchObject({ deduplicated: true });
  });

  it('does not share blobs across companies (tenant-scoped keys)', async () => {
    const bytes = 'tenant,scope\n1,2\n';
    const before = env.storage.objects.size;
    await upload(adminToken, { name: 'x.csv', content: bytes });
    await upload(otherToken, { name: 'x.csv', content: bytes });
    expect(env.storage.objects.size).toBe(before + 2);
    expect(env.storage.objects.has(blobKey(env.companyA, sha(bytes)))).toBe(true);
    expect(env.storage.objects.has(blobKey(env.companyB, sha(bytes)))).toBe(true);
  });

  it('sanitises the file name and honours a name override', async () => {
    // multipart qatı yol hissəsini özü atır; "name" sahəsi isə bizim sanitizasiyadan keçir
    const res = await upload(adminToken, { name: '../../etc/passwd.csv', content: 'a,b\n' });
    expect(res.json().name).toBe('passwd.csv');
    const traversal = await upload(
      adminToken,
      { name: 'u.csv', content: 'a,b1\n' },
      { name: '../../x/y.csv' },
    );
    expect(traversal.json().name).toBe('_.._x_y.csv');
    const renamed = await upload(
      adminToken,
      { name: 'upload.csv', content: 'a,b2\n' },
      { name: 'Qaimə Yanvar.csv' },
    );
    expect(renamed.json().name).toBe('Qaimə Yanvar.csv');
  });

  it('accepts JSON-array tags and rejects malformed ones', async () => {
    const ok = await upload(
      adminToken,
      { name: 't.csv', content: 'a,b3\n' },
      { tags: '["a","B"]' },
    );
    expect(ok.json().tags).toEqual(['a', 'b']);
    const bad = await upload(adminToken, { name: 't.csv', content: 'a,b4\n' }, { tags: '[1,2' });
    expect(bad.statusCode).toBe(422);
    const tooMany = await upload(
      adminToken,
      { name: 't.csv', content: 'a,b5\n' },
      {
        tags: Array.from({ length: 25 }, (_, i) => `t${i}`).join(','),
      },
    );
    expect(tooMany.statusCode).toBe(422);
  });

  it('rejects path traversal in folder with 422', async () => {
    const res = await upload(
      adminToken,
      { name: 'f.csv', content: 'a,b6\n' },
      { folder: '/a/../../etc' },
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  describe('validation (§11)', () => {
    it('enforces the size limit (413) and stores nothing', async () => {
      const before = env.storage.objects.size;
      const big = 'x,'.repeat(40 * 1024); // 80 KiB > 64 KiB limit
      const res = await upload(adminToken, { name: 'big.csv', content: big });
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
      expect(env.storage.objects.size).toBe(before);
    });

    it('rejects an empty file', async () => {
      const res = await upload(adminToken, { name: 'empty.pdf', content: Buffer.alloc(0) });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.message).toMatch(/empty/i);
    });

    it('rejects content that contradicts the declared MIME type', async () => {
      const res = await upload(adminToken, {
        name: 'inv.pdf',
        content: PNG_BYTES,
        type: 'application/pdf',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.message).toMatch(/does not match/);
    });

    it('rejects disallowed types: archives, executables, scripts', async () => {
      for (const f of [
        { name: 'a.zip', content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]) },
        { name: 'setup.exe', content: Buffer.from('MZ\x90\x00\x03\x00') },
        { name: 'x.html', content: '<script>alert(1)</script>' },
      ]) {
        const res = await upload(adminToken, f);
        expect(res.statusCode, f.name).toBe(422);
      }
    });

    it('requires multipart, a "file" field and exactly one file', async () => {
      const notMultipart = await env.app.inject({
        method: 'POST',
        url: '/api/v1/files',
        headers: env.bearer(adminToken),
        payload: { hello: 'world' },
      });
      expect(notMultipart.statusCode).toBe(415);

      const none = await upload(adminToken, null, { folder: '/x' });
      expect(none.statusCode).toBe(422);

      const wrongField = await upload(adminToken, {
        name: 'a.csv',
        content: 'a,b\n',
        field: 'document',
      });
      expect(wrongField.statusCode).toBe(422);
    });

    it('rejects infected files (antivirus) and never stores them', async () => {
      const before = env.storage.objects.size;
      const original = env.scanner.current;
      env.scanner.current = {
        scan: async () => ({ clean: false, signature: 'Eicar-Test-Signature' }),
        ping: async () => undefined,
      };
      try {
        const res = await upload(adminToken, { name: 'virus.csv', content: 'X5O!P%@AP,virus\n' });
        expect(res.statusCode).toBe(422);
        expect(res.json().error.message).toContain('Eicar-Test-Signature');
        expect(env.storage.objects.size).toBe(before);
      } finally {
        env.scanner.current = original;
      }
    });

    it('fails closed (503) when the antivirus scanner is unavailable', async () => {
      const before = env.storage.objects.size;
      const original = env.scanner.current;
      env.scanner.current = {
        scan: async () => {
          throw new ScannerUnavailableError('clamd down');
        },
        ping: async () => undefined,
      };
      try {
        const res = await upload(adminToken, { name: 'safe.csv', content: 'maybe,safe\n' });
        expect(res.statusCode).toBe(503);
        expect(res.json().error.code).toBe('UPSTREAM_UNAVAILABLE');
        expect(env.storage.objects.size).toBe(before);
      } finally {
        env.scanner.current = original;
        expect(env.scanner.current).toBeInstanceOf(NoopScanner);
      }
    });

    it('returns 503 when object storage is down and leaves no DB rows behind', async () => {
      const [{ n: filesBefore } = { n: -1 }] = await env.db.query<{ n: number }>(
        'SELECT count(*)::int n FROM files',
      );
      const original = env.storage.put.bind(env.storage);
      env.storage.put = async () => {
        throw new StorageError('s3 down', 'UNAVAILABLE');
      };
      try {
        const res = await upload(adminToken, { name: 'nostore.csv', content: 'no,store\n' });
        expect(res.statusCode).toBe(503);
        const [{ n: filesAfter } = { n: -1 }] = await env.db.query<{ n: number }>(
          'SELECT count(*)::int n FROM files',
        );
        expect(filesAfter).toBe(filesBefore);
      } finally {
        env.storage.put = original;
      }
    });
  });

  it('is permission-gated: viewer (read-only) gets 403', async () => {
    const res = await upload(viewerToken, { name: 'v.csv', content: 'a,b7\n' });
    expect(res.statusCode).toBe(403);
  });

  it('honours Idempotency-Key: a retry replays the first response and creates no second file', async () => {
    const file = { name: 'idem.csv', content: 'idem,potent\n1,1\n' };
    const key = { 'idempotency-key': 'upload-key-0001' };
    const first = await upload(adminToken, file, {}, key);
    const retry = await upload(adminToken, file, {}, key);
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json().id).toBe(first.json().id);
    const [{ n } = { n: -1 }] = await env.db.query<{ n: number }>(
      `SELECT count(*)::int n FROM files WHERE name = 'idem.csv'`,
    );
    expect(n).toBe(1);
  });
});

describe('extraction pipeline: pending → extracting → ready | failed', () => {
  it('extracts CSV text via the job worker', async () => {
    const f = await uploadCsv('pipeline.csv', {});
    expect(f.extraction.status).toBe('pending');
    expect(await env.worker.drain()).toBeGreaterThanOrEqual(1);

    const detail = (await get(adminToken, `/api/v1/files/${f.id}`)).json();
    expect(detail.extraction).toMatchObject({
      status: 'ready',
      detectedKind: 'csv',
      error: null,
      textLength: CSV_TEXT.length,
    });
    expect(detail.extractionStatus).toBe('ready');
    const [row] = await env.db.query<{ text: string; layout_json: { kind: string } }>(
      `SELECT e.text, e.layout_json FROM file_extractions e JOIN file_versions v ON v.id = e.file_version_id WHERE v.file_id = $1`,
      [f.id],
    );
    expect(row?.text).toBe(CSV_TEXT);
    expect(row?.layout_json).toMatchObject({ kind: 'csv', truncated: false });
  });

  it('an unreadable PDF ends as failed with a clear error (no retries); after a working extractor is registered, reindex succeeds', async () => {
    const res = await upload(adminToken, {
      name: 'scan.pdf',
      content: PDF_BYTES,
      type: 'application/pdf',
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    await env.worker.drain();

    let detail = (await get(adminToken, `/api/v1/files/${id}`)).json();
    expect(detail.extraction).toMatchObject({ status: 'failed', detectedKind: 'pdf' });
    expect(detail.extraction.error).toMatch(/PDF_UNREADABLE/); // pozuq PDF: təkrar cəhd olmadan failed

    env.extractors.register('pdf', async () => ({
      text: 'extracted pdf text',
      layout: { pages: 1 },
    }));
    const re = await post(adminToken, `/api/v1/files/${id}/reindex`);
    expect(re.statusCode).toBe(202);
    expect(re.json()).toMatchObject({ status: 'pending', error: null });
    await env.worker.drain();
    detail = (await get(adminToken, `/api/v1/files/${id}`)).json();
    expect(detail.extraction).toMatchObject({
      status: 'ready',
      textLength: 'extracted pdf text'.length,
    });
    expect(await actions()).toContain('file.reindex');
  });

  it('reindex while pending is idempotent (no second job); while extracting it is 409', async () => {
    const f = await uploadCsv('reindex.csv', {});
    const first = await post(adminToken, `/api/v1/files/${f.id}/reindex`);
    expect(first.statusCode).toBe(202);
    expect(first.json().status).toBe('pending');
    const [{ n } = { n: -1 }] = await env.db.query<{ n: number }>(
      `SELECT count(*)::int n FROM jobs WHERE payload->>'fileVersionId' = $1`,
      [f.versions[0].id],
    );
    expect(n).toBe(1);

    await env.db.query(
      `UPDATE file_extractions SET status = 'extracting' WHERE file_version_id = $1`,
      [f.versions[0].id],
    );
    const busy = await post(adminToken, `/api/v1/files/${f.id}/reindex`);
    expect(busy.statusCode).toBe(409);
    await env.worker.drain();
  });

  it('retries transient storage errors and finally marks the extraction failed', async () => {
    const f = await uploadCsv('flaky.csv', {});
    const versionId = f.versions[0].id as string;
    const key = blobKey(env.companyA, sha(CSV_TEXT));
    const original = env.storage.get.bind(env.storage);
    env.storage.get = async () => {
      throw new StorageError('s3 timeout', 'UNAVAILABLE');
    };
    try {
      // 1. cəhd: pending-ə qayıdır, iş gələcək vaxta planlanır
      await env.worker.runOnce();
      const [job1] = await env.db.query<{ status: string; attempts: number; run_at: Date }>(
        `SELECT status, attempts, run_at FROM jobs WHERE idempotency_key = $1`,
        [`extract:${versionId}`],
      );
      expect(job1).toMatchObject({ status: 'queued', attempts: 1 });
      expect(job1!.run_at.getTime()).toBeGreaterThan(Date.now());
      const ex1 = await env.repos.files.findExtraction(env.companyA, versionId);
      expect(ex1).toMatchObject({ status: 'pending' });
      expect(ex1?.error).toMatch(/s3 timeout/);

      // son cəhdə qədər sürətlə irəlilə
      await env.db.query(
        `UPDATE jobs SET attempts = max_attempts - 1, run_at = NOW() - interval '1 second' WHERE idempotency_key = $1`,
        [`extract:${versionId}`],
      );
      await env.worker.runOnce();
      const [job2] = await env.db.query<{ status: string }>(
        `SELECT status FROM jobs WHERE idempotency_key = $1`,
        [`extract:${versionId}`],
      );
      expect(job2?.status).toBe('dead');
      expect((await env.repos.files.findExtraction(env.companyA, versionId))?.status).toBe(
        'failed',
      );
    } finally {
      env.storage.get = original;
      expect(env.storage.objects.has(key)).toBe(true);
    }
  });
});

describe('GET /files, GET /files/:id, content', () => {
  it('lists own-company files only, newest first, with filters and cursor pagination', async () => {
    const mk = (name: string, content: string, fields: Record<string, string>) =>
      upload(adminToken, { name, content }, fields).then((r) => r.json());
    const f1 = await mk('list-a.csv', 'l1,a\n', { folder: '/lists', tags: 'alpha' });
    const f2 = await mk('list-b.csv', 'l2,b\n', { folder: '/lists', tags: 'beta' });
    const f3 = await mk('list-c.csv', 'l3,c\n', { folder: '/lists', tags: 'alpha,beta' });
    const foreign = await upload(
      otherToken,
      { name: 'list-foreign.csv', content: 'l4,d\n' },
      { folder: '/lists' },
    );

    const all = (await get(adminToken, '/api/v1/files?folder=/lists&limit=100')).json();
    const ids = all.items.map((i: { id: string }) => i.id);
    expect(ids).toEqual([f3.id, f2.id, f1.id]);
    expect(ids).not.toContain(foreign.json().id);

    const byTag = (await get(adminToken, '/api/v1/files?folder=/lists&tag=ALPHA')).json();
    expect(byTag.items.map((i: { id: string }) => i.id)).toEqual([f3.id, f1.id]);

    const byName = (await get(adminToken, '/api/v1/files?q=list-b')).json();
    expect(byName.items.map((i: { id: string }) => i.id)).toEqual([f2.id]);
    // LIKE joker simvolları ədəbi sayılır
    expect((await get(adminToken, '/api/v1/files?q=%25')).json().items).toEqual([]);

    const page1 = (await get(adminToken, '/api/v1/files?folder=/lists&limit=2')).json();
    expect(page1.items.map((i: { id: string }) => i.id)).toEqual([f3.id, f2.id]);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (
      await get(adminToken, `/api/v1/files?folder=/lists&limit=2&cursor=${page1.nextCursor}`)
    ).json();
    expect(page2.items.map((i: { id: string }) => i.id)).toEqual([f1.id]);
    expect(page2.nextCursor).toBeNull();

    expect((await get(adminToken, '/api/v1/files?cursor=garbage')).statusCode).toBe(422);
    expect((await get(adminToken, '/api/v1/files?limit=0')).statusCode).toBe(422);
  });

  it('hides archived files unless asked', async () => {
    const f = await uploadCsv('to-archive.csv', { folder: '/arch' });
    await post(adminToken, `/api/v1/files/${f.id}/archive`);
    expect((await get(adminToken, '/api/v1/files?folder=/arch')).json().items).toEqual([]);
    const withArchived = (
      await get(adminToken, '/api/v1/files?folder=/arch&includeArchived=true')
    ).json();
    expect(withArchived.items.map((i: { id: string }) => i.id)).toEqual([f.id]);
  });

  it('returns 404 for unknown ids and for another company’s file; 422 for malformed ids', async () => {
    const f = await uploadCsv('private.csv', { folder: '/private' });
    expect((await get(adminToken, `/api/v1/files/${randomUUID()}`)).statusCode).toBe(404);
    expect((await get(otherToken, `/api/v1/files/${f.id}`)).statusCode).toBe(404);
    expect((await get(otherToken, `/api/v1/files/${f.id}/content`)).statusCode).toBe(404);
    expect((await post(otherToken, `/api/v1/files/${f.id}/archive`)).statusCode).toBe(404);
    expect((await post(otherToken, `/api/v1/files/${f.id}/reindex`)).statusCode).toBe(404);
    expect((await get(adminToken, '/api/v1/files/not-a-uuid')).statusCode).toBe(422);
  });

  it('viewers can read and download', async () => {
    const f = await uploadCsv('readable.csv', { folder: '/readable' });
    expect((await get(viewerToken, `/api/v1/files/${f.id}`)).statusCode).toBe(200);
    expect((await get(viewerToken, '/api/v1/files')).statusCode).toBe(200);
    expect((await get(viewerToken, `/api/v1/files/${f.id}/content`)).statusCode).toBe(200);
  });

  it('streams the content with safe headers', async () => {
    const f = await upload(adminToken, {
      name: 'Qaimə "Yanvar".pdf',
      content: PDF_BYTES,
      type: 'application/pdf',
    }).then((r) => r.json());
    const res = await get(adminToken, `/api/v1/files/${f.id}/content`);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PDF_BYTES)).toBe(true);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="Qaim_ ?_Yanvar_?\.pdf"; filename\*=UTF-8''Qaim%C9%99%20%22Yanvar%22\.pdf$|^attachment;/,
    );
    expect(String(res.headers['content-disposition'])).toContain("filename*=UTF-8''Qaim%C9%99");
    expect(String(res.headers['content-disposition'])).not.toContain('"Yanvar"');
  });

  it('answers 500 (not a fake success) when the stored object has vanished', async () => {
    const f = await uploadCsv('vanish.csv', { folder: '/vanish' });
    env.storage.objects.delete(f.versions[0] && blobKey(env.companyA, f.versions[0].sha256));
    const res = await get(adminToken, `/api/v1/files/${f.id}/content`);
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL');
  });
});

describe('PATCH / archive', () => {
  it('updates name, folder and tags with a before/after audit trail', async () => {
    const f = await uploadCsv('patch.csv', { folder: '/old', tags: 'x' });
    const res = await env.app.inject({
      method: 'PATCH',
      url: `/api/v1/files/${f.id}`,
      headers: env.bearer(adminToken),
      payload: { name: 'renamed.csv', folder: 'new//place', tags: ['Final', 'final', 'Q2'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'renamed.csv',
      folder: '/new/place',
      tags: ['final', 'q2'],
    });
    const evt = (await env.repos.audit.listByCompany(env.companyA, 50)).find(
      (e) => e.action === 'file.update' && e.resourceId === f.id,
    );
    expect(evt).toMatchObject({
      before: { name: 'patch.csv', folder: '/old', tags: ['x'] },
      after: { name: 'renamed.csv', folder: '/new/place', tags: ['final', 'q2'] },
    });
  });

  it('supports partial updates and validates input', async () => {
    const f = await uploadCsv('partial.csv', { folder: '/p', tags: 'keep' });
    const patch = (payload: object, token = adminToken, id = f.id) =>
      env.app.inject({
        method: 'PATCH',
        url: `/api/v1/files/${id}`,
        headers: env.bearer(token),
        payload,
      });
    const r = await patch({ folder: '/q' });
    expect(r.json()).toMatchObject({ name: 'partial.csv', folder: '/q', tags: ['keep'] });
    expect((await patch({})).statusCode).toBe(422);
    expect((await patch({ folder: '/a/../b' })).statusCode).toBe(422);
    expect((await patch({ name: '...' })).statusCode).toBe(422);
    expect((await patch({ name: 'x' }, viewerToken)).statusCode).toBe(403);
    expect((await patch({ name: 'x' }, otherToken)).statusCode).toBe(404);
  });

  it('archive is idempotent, audited, and blocks edits/reindex afterwards (409)', async () => {
    const f = await uploadCsv('archive-me.csv', { folder: '/arch2' });
    const a1 = await post(adminToken, `/api/v1/files/${f.id}/archive`);
    expect(a1.statusCode).toBe(200);
    const archivedAt = a1.json().archivedAt as string;
    expect(archivedAt).toBeTruthy();
    const a2 = await post(adminToken, `/api/v1/files/${f.id}/archive`);
    expect(a2.json().archivedAt).toBe(archivedAt);

    const patch = await env.app.inject({
      method: 'PATCH',
      url: `/api/v1/files/${f.id}`,
      headers: env.bearer(adminToken),
      payload: { name: 'nope.csv' },
    });
    expect(patch.statusCode).toBe(409);
    expect((await post(adminToken, `/api/v1/files/${f.id}/reindex`)).statusCode).toBe(409);
    expect((await actions()).filter((a) => a === 'file.archive').length).toBeGreaterThanOrEqual(2);
    // fayl hələ də oxunur
    expect((await get(adminToken, `/api/v1/files/${f.id}`)).statusCode).toBe(200);
  });

  it('there is no hard-delete endpoint', async () => {
    const f = await uploadCsv('keep.csv', { folder: '/keep' });
    const res = await env.app.inject({
      method: 'DELETE',
      url: `/api/v1/files/${f.id}`,
      headers: env.bearer(adminToken),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('every file write is audited (§16)', () => {
  it('upload, update, archive and reindex all leave audit_events', async () => {
    const seen = new Set(await actions());
    for (const a of ['file.upload', 'file.update', 'file.archive', 'file.reindex']) {
      expect(seen.has(a), a).toBe(true);
    }
  });
});
