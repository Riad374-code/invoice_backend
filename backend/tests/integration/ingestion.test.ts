import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseFeed, parseHtmlList, extractDocumentText } from '../../src/ingestion/adapters.js';
import { diffText } from '../../src/ingestion/diff.js';
import {
  FetchBlockedError,
  SafeFetcher,
  isPrivateAddress,
  type FetchResult,
  type PageFetcher,
} from '../../src/ingestion/fetcher.js';
import { runSourceFetch } from '../../src/ingestion/pipeline.js';
import { parseRobots } from '../../src/ingestion/robots.js';
import { canonicalizeUrl, sameSite } from '../../src/ingestion/url.js';
import { sourcesHealthHandler, sourcesTickHandler } from '../../src/jobs/ingestion.js';
import { createTestEnv, type TestEnv } from '../helpers/app.js';

describe('canonicalizeUrl / sameSite', () => {
  it('normalises for dedupe: host case, fragments, tracking params, param order, trailing slash', () => {
    const a = canonicalizeUrl('HTTPS://WWW.Taxes.gov.az:443/news/1/?utm_source=x&b=2&a=1#top');
    expect(a).toBe('https://www.taxes.gov.az/news/1?a=1&b=2');
    expect(canonicalizeUrl('/news/1?a=1&b=2&fbclid=zz', 'https://www.taxes.gov.az/')).toBe(a);
  });
  it('rejects non-http schemes', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x/y'])
      expect(() => canonicalizeUrl(bad)).toThrow();
  });
  it('keeps scope on the source site and its sub-domains only', () => {
    expect(sameSite('https://news.taxes.gov.az/a', 'https://www.taxes.gov.az')).toBe(true);
    expect(sameSite('https://taxes.gov.az/a', 'https://www.taxes.gov.az')).toBe(true);
    expect(sameSite('https://evil.com/a', 'https://www.taxes.gov.az')).toBe(false);
    expect(sameSite('https://taxes.gov.az.evil.com/a', 'https://www.taxes.gov.az')).toBe(false);
  });
});

describe('robots.txt', () => {
  const txt = `User-agent: *\nDisallow: /private\nAllow: /private/public\nCrawl-delay: 5\n\nUser-agent: LexAuditBot\nDisallow: /secret\nDisallow: /*.pdf$\n`;
  it('prefers our own group, longest match wins, wildcards and $ anchors work', () => {
    const r = parseRobots(txt, 'LexAuditBot/1.0');
    expect(r.allows('/secret/x')).toBe(false);
    expect(r.allows('/private')).toBe(true); // bizim qrupda yoxdur
    expect(r.allows('/files/a.pdf')).toBe(false);
    expect(r.allows('/files/a.pdf.html')).toBe(true);
  });
  it('falls back to * rules and Crawl-delay', () => {
    const r = parseRobots(txt, 'OtherBot');
    expect(r.allows('/private/data')).toBe(false);
    expect(r.allows('/private/public/x')).toBe(true);
    expect(r.crawlDelaySeconds).toBe(5);
    expect(parseRobots('', 'x').allows('/anything')).toBe(true);
    expect(parseRobots('User-agent: *\nDisallow:\n', 'x').allows('/a')).toBe(true);
    expect(parseRobots('User-agent: *\nDisallow: /\n', 'x').allows('/a')).toBe(false);
  });
});

describe('SafeFetcher — SSRF, size, redirects, politeness', () => {
  const resp = (body: string, init: { status?: number; headers?: Record<string, string> } = {}) =>
    new Response(body, { status: init.status ?? 200, headers: init.headers });
  const mk = (
    handler: (url: string) => Response,
    extra: Partial<ConstructorParameters<typeof SafeFetcher>[0]> = {},
  ) => {
    const calls: string[] = [];
    const f = new SafeFetcher({
      userAgent: 'TestBot/1.0',
      minIntervalMs: 0,
      resolve: async (h) =>
        h === 'internal.example'
          ? ['10.0.0.5']
          : h === 'meta.example'
            ? ['169.254.169.254']
            : ['93.184.216.34'],
      fetchImpl: (async (u: URL | string) => {
        calls.push(String(u));
        return handler(String(u));
      }) as typeof fetch,
      ...extra,
    });
    return { f, calls };
  };

  it('classifies private/loopback/link-local/metadata addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700::1'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses private targets, bad schemes and URL credentials before any request is made', async () => {
    const { f, calls } = mk(() => resp('x'));
    for (const url of [
      'http://internal.example/a',
      'http://meta.example/latest',
      'http://127.0.0.1/a',
      'http://[::1]/a',
      'file:///etc/passwd',
      'http://user:pw@public.example/a',
    ]) {
      await expect(f.get(url), url).rejects.toBeInstanceOf(FetchBlockedError);
    }
    expect(calls).toEqual([]);
  });

  it('blocks a redirect that leads to an internal address (open-redirect SSRF)', async () => {
    const { f, calls } = mk((u) =>
      u.endsWith('/robots.txt')
        ? resp('', { status: 404 })
        : resp('', { status: 302, headers: { location: 'http://meta.example/secret' } }),
    );
    await expect(f.get('https://public.example/news')).rejects.toBeInstanceOf(FetchBlockedError);
    expect(calls.some((c) => c.includes('meta.example'))).toBe(false);
  });

  it('follows safe redirects, caps redirect chains and body size', async () => {
    const ok = mk((u) =>
      u.endsWith('/robots.txt')
        ? resp('', { status: 404 })
        : u.endsWith('/a')
          ? resp('', { status: 301, headers: { location: '/b' } })
          : resp('final'),
    );
    expect((await ok.f.get('https://public.example/a')).body).toBe('final');
    const loop = mk((u) =>
      u.endsWith('/robots.txt')
        ? resp('', { status: 404 })
        : resp('', { status: 302, headers: { location: '/again' } }),
    );
    await expect(loop.f.get('https://public.example/a')).rejects.toThrow(/Too many redirects/);
    const big = mk(
      (u) => (u.endsWith('/robots.txt') ? resp('', { status: 404 }) : resp('x'.repeat(2000))),
      { maxBytes: 1000 },
    );
    await expect(big.f.get('https://public.example/a')).rejects.toThrow(/too large/);
  });

  it('honours robots.txt (fetched once per origin) and rate-limits per host', async () => {
    const slept: number[] = [];
    let t = 1000;
    const { f, calls } = mk(
      (u) => (u.endsWith('/robots.txt') ? resp('User-agent: *\nDisallow: /admin\n') : resp('ok')),
      { minIntervalMs: 2000, sleep: async (ms) => void slept.push(ms), now: () => t },
    );
    await expect(f.get('https://public.example/admin/x')).rejects.toThrow(/robots/);
    await f.get('https://public.example/a');
    t += 500;
    await f.get('https://public.example/b');
    expect(calls.filter((c) => c.endsWith('/robots.txt'))).toHaveLength(1);
    expect(slept.some((ms) => ms >= 1400 && ms <= 2000)).toBe(true);
  });
});

describe('adapters', () => {
  it('parses RSS and Atom; rejects DTDs and malformed feeds', () => {
    const rss = `<rss><channel><item><title>A</title><link>https://x.az/a</link><pubDate>Wed, 01 May 2030 10:00:00 GMT</pubDate><description>desc</description></item></channel></rss>`;
    expect(parseFeed(rss)).toEqual([
      {
        title: 'A',
        url: 'https://x.az/a',
        publishedAt: new Date('2030-05-01T10:00:00Z'),
        summary: 'desc',
      },
    ]);
    const atom = `<feed><entry><title>B</title><link rel="alternate" href="https://x.az/b"/><updated>2030-05-02T00:00:00Z</updated></entry></feed>`;
    expect(parseFeed(atom)[0]).toMatchObject({ title: 'B', url: 'https://x.az/b' });
    expect(() => parseFeed('<!DOCTYPE x [<!ENTITY a "b">]><rss/>')).toThrow();
    expect(() => parseFeed('<rss><channel>')).toThrow();
  });
  it('extracts list items and clean document text without scripts', () => {
    const html = `<ul><li class="n"><a href="/n/1">First</a><time datetime="2030-05-01">x</time></li><li class="n"><a href="/n/2">Second</a></li></ul>`;
    const items = parseHtmlList(html, 'https://x.az', { item: 'li.n', link: 'a', date: 'time' });
    expect(items.map((i) => i.url)).toEqual(['https://x.az/n/1', 'https://x.az/n/2']);
    expect(items[0]?.publishedAt?.toISOString()).toBe('2030-05-01T00:00:00.000Z');
    const doc = extractDocumentText(
      `<div id="c"><script>evil()</script><h1>Title</h1><p>Madde 1.  Birinci  mətn</p><p>Madde 2.</p></div>`,
      { content: '#c', title: 'h1' },
    );
    expect(doc.text).toBe('Title\n\nMadde 1. Birinci mətn\n\nMadde 2.');
    expect(() => extractDocumentText('<p>x</p>', { content: '#nope' })).toThrow(/matched nothing/);
  });
  it('diffText marks added/removed paragraphs', () => {
    const d = diffText('A\nB\nC', 'A\nB2\nC\nD');
    expect(d.filter((h) => h.type !== 'unchanged').map((h) => `${h.type}:${h.text}`)).toEqual([
      'removed:B',
      'added:B2',
      'added:D',
    ]);
  });
});

// ------------------------------------------------------------------ pipeline
let env: TestEnv;
let token: string;
let otherToken: string;
const page = (body: string): FetchResult => ({
  url: '',
  status: 200,
  contentType: 'text/html',
  body,
});
class FakeFetcher implements PageFetcher {
  pages = new Map<string, FetchResult | Error>();
  calls: string[] = [];
  async get(url: string): Promise<FetchResult> {
    this.calls.push(url);
    const r = this.pages.get(url);
    if (!r) return { url, status: 404, contentType: '', body: '' };
    if (r instanceof Error) throw r;
    return r;
  }
}

beforeAll(async () => {
  env = await createTestEnv({ loginRateLimitPerMinute: 1000 });
  token = (await env.login(env.admin.email)).accessToken;
  otherToken = (await env.login(env.otherCompanyAdmin.email)).accessToken;
});
afterAll(() => env.close());

const rss = (items: Array<[string, string]>) =>
  `<rss><channel>${items.map(([t, u]) => `<item><title>${t}</title><link>${u}</link></item>`).join('')}</channel></rss>`;
async function source(name: string, patch: Parameters<typeof env.repos.ingestion.updateSource>[1]) {
  const s = (await env.repos.ingestion.listSources()).find((x) => x.name === name)!;
  await env.repos.ingestion.updateSource(s.id, patch);
  return (await env.repos.ingestion.getSource(s.id))!;
}

describe('seeded sources', () => {
  it('contains every initial source from BACKEND.md §8.1, all disabled until reviewed', async () => {
    const s = await env.repos.ingestion.listSources();
    const hosts = s.map((x) => new URL(x.url).hostname.replace(/^www\./, ''));
    for (const h of [
      'e-qanun.az',
      'taxes.gov.az',
      'maliyye.gov.az',
      'cbar.az',
      'meclis.gov.az',
      'cabmin.gov.az',
      'president.az',
      'dsmf.gov.az',
      'ifrs.org',
    ])
      expect(hosts, h).toContain(h);
    expect(s.every((x) => !x.enabled)).toBe(true);
  });
  it('a source with no adapter fails visibly instead of silently doing nothing', async () => {
    const s = (await env.repos.ingestion.listSources())[0]!;
    const stats = await runSourceFetch(
      { db: env.db, repos: env.repos, fetcher: new FakeFetcher() },
      s,
    );
    expect(stats.status).toBe('failed');
    const [run] = await env.repos.ingestion.listRuns(s.id, 1);
    expect(run).toMatchObject({ status: 'failed' });
    expect(run?.error).toMatch(/no adapter/);
  });
});

describe('news ingestion: dedupe, scope, error visibility', () => {
  it('stores new items, dedupes on re-run (by canonical URL), blocks out-of-scope links, records the run', async () => {
    const src = await source('Dövlət Vergi Xidməti (taxes.gov.az)', {
      adapter: 'rss',
      config: { feedUrl: 'https://www.taxes.gov.az/rss.xml' },
      enabled: true,
    });
    const f = new FakeFetcher();
    f.pages.set(
      'https://www.taxes.gov.az/rss.xml',
      page(
        rss([
          ['One', 'https://www.taxes.gov.az/n/1?utm_source=rss'],
          ['Two', 'https://www.taxes.gov.az/n/2/'],
          ['Evil', 'https://evil.example/x'],
          ['Local', 'http://127.0.0.1/x'],
        ]),
      ),
    );
    const run = () => runSourceFetch({ db: env.db, repos: env.repos, fetcher: f }, src);

    const first = await run();
    expect(first).toMatchObject({ status: 'partial', itemsNew: 2, itemsSeen: 4 });
    expect(first.errors.join()).toMatch(/Out-of-scope/);
    const second = await run();
    expect(second.itemsNew).toBe(0);
    const [{ n } = { n: -1 }] = await env.db.query<{ n: number }>(
      `SELECT count(*)::int n FROM news_items`,
    );
    expect(n).toBe(2);
    const [{ c } = { c: '' }] = await env.db.query<{ c: string }>(
      `SELECT canonical_url c FROM news_items WHERE title = 'One'`,
    );
    expect(c).toBe('https://www.taxes.gov.az/n/1');
  });

  it('a failing feed is recorded as failed with the error (never swallowed)', async () => {
    const src = (await env.repos.ingestion.getSource(
      (await env.repos.ingestion.listSources()).find((x) => x.name.startsWith('Dövlət Vergi'))!.id,
    ))!;
    const f = new FakeFetcher();
    f.pages.set(
      'https://www.taxes.gov.az/rss.xml',
      new FetchBlockedError('robots.txt disallows /rss.xml'),
    );
    const stats = await runSourceFetch({ db: env.db, repos: env.repos, fetcher: f }, src);
    expect(stats.status).toBe('failed');
    expect((await env.repos.ingestion.listRuns(src.id, 1))[0]?.error).toMatch(/robots/);
  });

  it('API: list/get with per-user read & bookmark state (other users unaffected), audited', async () => {
    const list = await env.app.inject({
      method: 'GET',
      url: '/api/v1/news?limit=10',
      headers: env.bearer(token),
    });
    const items = list.json().items as Array<{ id: string; title: string; read: boolean }>;
    expect(items.map((i) => i.title).sort()).toEqual(['One', 'Two']);
    const id = items[0]!.id;
    const put = (t: string, path: string, body = {}) =>
      env.app.inject({
        method: 'PUT',
        url: `/api/v1/news/${id}/${path}`,
        headers: env.bearer(t),
        payload: body,
      });
    expect((await put(token, 'read')).json().read).toBe(true);
    expect((await put(token, 'bookmark')).json().bookmarked).toBe(true);
    // başqa istifadəçi (başqa şirkət) görmür
    const other = (
      await env.app.inject({
        method: 'GET',
        url: `/api/v1/news/${id}`,
        headers: env.bearer(otherToken),
      })
    ).json();
    expect([other.read, other.bookmarked]).toEqual([false, false]);
    expect(
      (
        await env.app.inject({
          method: 'GET',
          url: '/api/v1/news?unread=true',
          headers: env.bearer(token),
        })
      )
        .json()
        .items.map((i: { id: string }) => i.id),
    ).not.toContain(id);
    expect(
      (
        await env.app.inject({
          method: 'GET',
          url: '/api/v1/news?bookmarked=true',
          headers: env.bearer(token),
        })
      )
        .json()
        .items.map((i: { id: string }) => i.id),
    ).toEqual([id]);
    expect((await put(token, 'read', { value: false })).json().read).toBe(false);
    expect(
      (
        await env.app.inject({
          method: 'PUT',
          url: `/api/v1/news/${crypto.randomUUID()}/read`,
          headers: env.bearer(token),
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect((await env.repos.audit.listByCompany(env.companyA, 100)).map((e) => e.action)).toEqual(
      expect.arrayContaining(['news.read', 'news.bookmark']),
    );
  });
});

describe('legislation versioning', () => {
  const docUrl = 'https://e-qanun.az/framework/1';
  const html = (paras: string[]) =>
    `<div id="law">${paras.map((p) => `<p>${p}</p>`).join('')}</div>`;
  let docId: string;

  it('first fetch = version 1; unchanged content is a no-op; a changed text opens version 2 and closes version 1', async () => {
    const src = await source('e-qanun.az', {
      adapter: 'html_document',
      enabled: true,
      config: {
        documents: [
          {
            url: docUrl,
            type: 'code',
            officialNumber: 'VM',
            title: 'Vergi Məcəlləsi',
            adoptedAt: '2000-07-11',
            content: { content: '#law' },
          },
        ],
      },
    });
    const f = new FakeFetcher();
    const clock = { now: new Date('2030-03-01T08:00:00Z') };
    const run = () =>
      runSourceFetch({ db: env.db, repos: env.repos, fetcher: f, now: () => clock.now }, src);

    f.pages.set(
      docUrl,
      page(html(['Madde 1. ƏDV dərəcəsi on səkkiz faizdir.', 'Madde 2. Azadolmalar.'])),
    );
    expect((await run()).itemsNew).toBe(1);
    docId = (await env.repos.ingestion.listDocuments({ q: 'Vergi', limit: 5, offset: 0 }))[0]!.id;

    expect((await run()).itemsNew).toBe(0); // eyni mətn
    f.pages.set(
      docUrl,
      page(html(['Madde 1.   ƏDV dərəcəsi on səkkiz faizdir.', 'Madde 2. Azadolmalar.'])),
    ); // yalnız boşluq fərqi
    expect((await run()).itemsNew).toBe(0);
    expect((await env.repos.ingestion.listVersions(docId)).length).toBe(1);

    clock.now = new Date('2030-07-01T08:00:00Z');
    f.pages.set(
      docUrl,
      page(html(['Madde 1. ƏDV dərəcəsi iyirmi faizdir.', 'Madde 2. Azadolmalar.'])),
    );
    expect((await run()).itemsNew).toBe(1);
    const versions = await env.repos.ingestion.listVersions(docId);
    expect(versions.map((v) => [v.versionNo, v.validFrom, v.validTo])).toEqual([
      [2, '2030-07-01', null],
      [1, '2000-07-11', '2030-06-30'],
    ]);
  });

  it('API: version in force on a date, version list and diff', async () => {
    const at = async (date: string) =>
      (
        await env.app.inject({
          method: 'GET',
          url: `/api/v1/legislation/${docId}?date=${date}`,
          headers: env.bearer(token),
        })
      ).json();
    expect((await at('2030-06-30')).version.fullText).toContain('on səkkiz');
    expect((await at('2030-07-01')).version.fullText).toContain('iyirmi');
    expect((await at('1999-01-01')).version).toBeNull();
    const current = (
      await env.app.inject({
        method: 'GET',
        url: `/api/v1/legislation/${docId}`,
        headers: env.bearer(token),
      })
    ).json();
    expect(current).toMatchObject({
      latestVersionNo: 2,
      currentValidFrom: '2030-07-01',
      version: { versionNo: 2 },
    });

    const versions = (
      await env.app.inject({
        method: 'GET',
        url: `/api/v1/legislation/${docId}/versions`,
        headers: env.bearer(token),
      })
    ).json();
    expect(versions.map((v: { versionNo: number }) => v.versionNo)).toEqual([2, 1]);
    const diff = (
      await env.app.inject({
        method: 'GET',
        url: `/api/v1/legislation/${docId}/diff?from=1&to=2`,
        headers: env.bearer(token),
      })
    ).json();
    expect(
      diff.hunks
        .filter((h: { type: string }) => h.type !== 'unchanged')
        .map((h: { type: string; text: string }) => `${h.type}:${h.text}`),
    ).toEqual([
      'removed:Madde 1. ƏDV dərəcəsi on səkkiz faizdir.',
      'added:Madde 1. ƏDV dərəcəsi iyirmi faizdir.',
    ]);
    expect(
      (
        await env.app.inject({
          method: 'GET',
          url: `/api/v1/legislation/${docId}/diff?from=1&to=9`,
          headers: env.bearer(token),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await env.app.inject({
          method: 'GET',
          url: `/api/v1/legislation/${docId}?date=2030-02-30`,
          headers: env.bearer(token),
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await env.app.inject({
          method: 'GET',
          url: `/api/v1/legislation/${crypto.randomUUID()}`,
          headers: env.bearer(token),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('DB refuses overlapping version periods', async () => {
    await expect(
      env.db.query(
        `INSERT INTO legislation_versions (document_id, version_no, valid_from, full_text, source_url, content_hash) VALUES ($1, 9, '2030-08-01', 'x', 'u', $2)`,
        [docId, 'a'.repeat(64)],
      ),
    ).rejects.toMatchObject({ kind: 'CONFLICT' });
  });

  it('a suspiciously empty extraction is rejected (broken selector must not create an empty "law")', async () => {
    const src = (await env.repos.ingestion.listSources()).find((x) => x.name === 'e-qanun.az')!;
    const f = new FakeFetcher();
    f.pages.set(docUrl, page('<div id="law"><p>x</p></div>'));
    const stats = await runSourceFetch({ db: env.db, repos: env.repos, fetcher: f }, src);
    expect(stats.errors.join()).toMatch(/too short|short/);
    expect((await env.repos.ingestion.listVersions(docId)).length).toBe(2);
  });
});

describe('scheduling and health', () => {
  it('sources.tick enqueues only sources whose cron is due, once per minute', async () => {
    const jobDeps = {
      db: env.db,
      repos: env.repos,
      storage: env.storage,
      extractors: env.extractors,
      log: { info() {}, warn() {}, error() {} },
    };
    await env.db.query(`DELETE FROM jobs`);
    await env.db.query(`UPDATE fetch_runs SET started_at = NOW() - interval '3 days'`);
    const fakeJob = { queue: 'sources.tick' } as never;
    const first = (await sourcesTickHandler(fakeJob, jobDeps)) as { enqueued: number };
    expect(first.enqueued).toBeGreaterThanOrEqual(1); // heç vaxt işləməyib → vaxtı çatıb
    expect(((await sourcesTickHandler(fakeJob, jobDeps)) as { enqueued: number }).enqueued).toBe(0); // eyni dəqiqə: idempotent
  });

  it('sources.health opens ONE stale alert per source after 24h without success, and resolves it on recovery', async () => {
    const jobDeps = {
      db: env.db,
      repos: env.repos,
      storage: env.storage,
      extractors: env.extractors,
      log: { info() {}, warn() {}, error() {} },
    };
    const fakeJob = { queue: 'sources.health' } as never;
    await env.db.query(`UPDATE fetch_runs SET finished_at = NOW() - interval '30 hours'`);
    await sourcesHealthHandler(fakeJob, jobDeps);
    await sourcesHealthHandler(fakeJob, jobDeps);
    const alerts = (
      await env.app.inject({
        method: 'GET',
        url: '/api/v1/admin/alerts',
        headers: env.bearer(token),
      })
    ).json() as Array<{ kind: string; message: string }>;
    expect(alerts.filter((a) => a.kind === 'source_stale').length).toBe(2); // 2 aktiv mənbə, hər biri bir dəfə
    expect(alerts[0]?.message).toMatch(/24h/);
    await env.db.query(`UPDATE fetch_runs SET finished_at = NOW(), status = 'success'`);
    await sourcesHealthHandler(fakeJob, jobDeps);
    expect(
      (
        (
          await env.app.inject({
            method: 'GET',
            url: '/api/v1/admin/alerts',
            headers: env.bearer(token),
          })
        ).json() as unknown[]
      ).length,
    ).toBe(0);
  });

  it('viewer can read news/legislation but not alerts', async () => {
    const v = (await env.login(env.viewer.email)).accessToken;
    expect(
      (await env.app.inject({ method: 'GET', url: '/api/v1/news', headers: env.bearer(v) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await env.app.inject({ method: 'GET', url: '/api/v1/legislation', headers: env.bearer(v) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await env.app.inject({ method: 'GET', url: '/api/v1/admin/alerts', headers: env.bearer(v) }))
        .statusCode,
    ).toBe(403);
  });
});
