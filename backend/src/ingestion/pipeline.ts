import { createHash } from 'node:crypto';
import type { Db, Repos } from '../db/index.js';
import { createRepos } from '../db/index.js';
import type { SourceRow } from '../db/repos/ingestion.js';
import {
  extractDocumentText,
  parseFeed,
  parseHtmlList,
  type FeedItem,
  type HtmlDocumentConfig,
  type HtmlListConfig,
} from './adapters.js';
import { FetchBlockedError, type PageFetcher } from './fetcher.js';
import { QUEUES } from '../jobs/types.js';
import { canonicalizeUrl, sameSite } from './url.js';

export interface PipelineDeps {
  db: Db;
  repos: Repos;
  fetcher: PageFetcher;
  now?: () => Date;
  log?: { warn(o: object, m: string): void };
}

export interface FetchStats {
  status: 'success' | 'partial' | 'failed';
  itemsNew: number;
  itemsSeen: number;
  errors: string[];
}

const MAX_ITEMS = 100;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Hash üçün boşluqlar normallaşdırılır: formatlama dəyişikliyi "yeni məzmun" sayılmasın. */
export const normalizeForHash = (s: string) => s.replace(/\s+/g, ' ').trim();
const today = (d: Date) => d.toISOString().slice(0, 10);

interface NewsConfig {
  feedUrl?: string;
  list?: HtmlListConfig;
  article?: HtmlDocumentConfig;
}
interface LegislationConfig {
  documents: Array<{
    url: string;
    type: 'code' | 'law' | 'decree' | 'cabinet_decision' | 'standard';
    officialNumber?: string;
    adoptedAt?: string;
    title?: string;
    language?: string;
    content: HtmlDocumentConfig;
    initialValidFrom?: string;
  }>;
}

async function ingestNews(deps: PipelineDeps, source: SourceRow, stats: FetchStats): Promise<void> {
  const cfg = source.config as NewsConfig;
  let items: FeedItem[];
  if (source.adapter === 'rss') {
    const res = await deps.fetcher.get(cfg.feedUrl ?? source.url);
    if (res.status !== 200) throw new Error(`Feed returned HTTP ${res.status}`);
    items = parseFeed(res.body);
  } else if (source.adapter === 'html_list') {
    if (!cfg.list) throw new Error('html_list adapter needs config.list selectors');
    const res = await deps.fetcher.get(source.url);
    if (res.status !== 200) throw new Error(`List page returned HTTP ${res.status}`);
    items = parseHtmlList(res.body, source.url, cfg.list);
  } else {
    throw new Error(`Adapter "${source.adapter}" cannot ingest news`);
  }

  const now = (deps.now ?? (() => new Date()))();
  for (const item of items.slice(0, MAX_ITEMS)) {
    stats.itemsSeen++;
    try {
      // Kənar domenə yönləndirən linklər izlənmir (scope + SSRF qoruması)
      if (!sameSite(item.url, source.url))
        throw new FetchBlockedError(`Out-of-scope link ${item.url}`);
      const canonical = canonicalizeUrl(item.url);
      if (await deps.repos.ingestion.newsExists(canonical)) continue; // dedupe: səhifəni yenidən çəkmirik
      let text = item.summary ?? item.title;
      if (cfg.article) {
        const page = await deps.fetcher.get(canonical);
        if (page.status !== 200) throw new Error(`Article returned HTTP ${page.status}`);
        text = extractDocumentText(page.body, cfg.article).text || text;
      }
      const newsId = await deps.repos.ingestion.insertNews(
        {
          sourceId: source.id,
          title: item.title,
          originalUrl: item.url,
          canonicalUrl: canonical,
          contentHash: sha256(normalizeForHash(text)),
          publishedAt: item.publishedAt,
          rawText: text,
        },
        now,
      );
      if (newsId) {
        stats.itemsNew++;
        await deps.repos.jobs.enqueue(
          {
            queue: QUEUES.CHUNKS_INDEX,
            payload: { resourceType: 'news', resourceId: newsId },
            idempotencyKey: `index:news:${newsId}`,
          },
          now,
        );
        await deps.repos.jobs.enqueue(
          {
            queue: QUEUES.NEWS_ENRICH,
            payload: { newsId },
            maxAttempts: 6,
            idempotencyKey: `enrich:${newsId}`,
          },
          now,
        );
      }
    } catch (e) {
      stats.errors.push(`${item.url}: ${(e as Error).message}`);
    }
  }
}

async function ingestLegislation(
  deps: PipelineDeps,
  source: SourceRow,
  stats: FetchStats,
): Promise<void> {
  const cfg = source.config as unknown as LegislationConfig;
  if (!cfg.documents?.length) throw new Error('html_document adapter needs config.documents');
  const now = (deps.now ?? (() => new Date()))();
  for (const doc of cfg.documents) {
    stats.itemsSeen++;
    try {
      if (!sameSite(doc.url, source.url))
        throw new FetchBlockedError(`Out-of-scope document ${doc.url}`);
      const canonical = canonicalizeUrl(doc.url);
      const page = await deps.fetcher.get(canonical);
      if (page.status !== 200) throw new Error(`Document returned HTTP ${page.status}`);
      const { title, text } = extractDocumentText(page.body, doc.content);
      if (text.length < 20)
        throw new Error('Extracted text is suspiciously short — selector probably wrong');
      const hash = sha256(normalizeForHash(text));

      const isNew = await deps.db.tx(async (tx) => {
        const r = createRepos(tx);
        const { id } = await r.ingestion.upsertDocument({
          sourceId: source.id,
          type: doc.type,
          officialNumber: doc.officialNumber ?? null,
          adoptedAt: doc.adoptedAt ?? null,
          title: doc.title ?? title ?? canonical,
          language: doc.language ?? 'az',
          sourceUrl: doc.url,
          canonicalUrl: canonical,
        });
        await r.ingestion.lockDocument(id); // paralel fetch-lər versiya nömrəsini pozmasın
        const latest = await r.ingestion.latestVersion(id);
        if (latest && latest.contentHash === hash) return false; // dəyişiklik yoxdur
        // valid_from: ilk versiya — qəbul/ilkin tarix; sonrakılar — dəyişikliyin aşkarlandığı gün (aktın real qüvvəyə minmə tarixi
        // məlumdursa admin düzəltməlidir; sistem onu uydurmur)
        const validFrom = latest
          ? today(now)
          : (doc.initialValidFrom ?? doc.adoptedAt ?? today(now));
        if (latest && validFrom <= latest.validFrom) return false; // eyni gün ikinci dəyişiklik: tarix toqquşmasın deyə növbəti fetch-ə
        await r.ingestion.addVersion(id, {
          validFrom,
          fullText: text,
          sourceUrl: doc.url,
          contentHash: hash,
        });
        return true;
      });
      if (isNew) stats.itemsNew++;
    } catch (e) {
      stats.errors.push(`${doc.url}: ${(e as Error).message}`);
    }
  }
}

/** Bir mənbənin tam fetch dövrü: fetch_runs yazılır, xətalar görünür qalır (susmur). */
export async function runSourceFetch(deps: PipelineDeps, source: SourceRow): Promise<FetchStats> {
  const now = deps.now ?? (() => new Date());
  const runId = await deps.repos.ingestion.startRun(source.id, now());
  const stats: FetchStats = { status: 'success', itemsNew: 0, itemsSeen: 0, errors: [] };
  try {
    if (!source.adapter)
      throw new Error(
        'Source has no adapter configured (needs admin setup and robots.txt/terms review)',
      );
    if (source.kind === 'legislation') await ingestLegislation(deps, source, stats);
    else await ingestNews(deps, source, stats);
    if (stats.errors.length > 0)
      stats.status =
        stats.itemsNew > 0 || stats.errors.length < stats.itemsSeen ? 'partial' : 'failed';
  } catch (e) {
    stats.status = 'failed';
    stats.errors.push((e as Error).message);
  }
  await deps.repos.ingestion.finishRun(
    runId,
    {
      status: stats.status,
      itemsNew: stats.itemsNew,
      itemsSeen: stats.itemsSeen,
      error: stats.errors.length ? stats.errors.slice(0, 20).join('\n') : null,
    },
    now(),
  );
  return stats;
}
