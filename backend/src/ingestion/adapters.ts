/* eslint-disable @typescript-eslint/no-explicit-any -- feed XML shape is untyped */
import * as cheerio from 'cheerio';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export interface FeedItem {
  title: string;
  url: string;
  publishedAt: Date | null;
  summary: string | null;
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  parseTagValue: false,
});
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object' && '#text' in v)
    return str((v as Record<string, unknown>)['#text']);
  return null;
};
const date = (v: string | null): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** RSS 2.0 və Atom lentləri. */
export function parseFeed(body: string): FeedItem[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(body))
    throw new Error('DTD/entity declarations are not allowed in feeds');
  const valid = XMLValidator.validate(body);
  if (valid !== true) throw new Error(`Malformed feed: ${valid.err.msg}`);
  const doc = xml.parse(body) as Record<string, any>;
  const out: FeedItem[] = [];
  for (const it of arr(doc['rss']?.['channel']?.['item'])) {
    const url = str(it['link']);
    const title = str(it['title']);
    if (url && title)
      out.push({
        title,
        url,
        publishedAt: date(str(it['pubDate']) ?? str(it['dc:date'])),
        summary: str(it['description']),
      });
  }
  for (const e of arr(doc['feed']?.['entry'])) {
    const links = arr(e['link']);
    const href = (links.find((l: any) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0])?.[
      '@_href'
    ];
    const title = str(e['title']);
    if (href && title)
      out.push({
        title,
        url: href,
        publishedAt: date(str(e['published']) ?? str(e['updated'])),
        summary: str(e['summary']),
      });
  }
  return out;
}

export interface HtmlListConfig {
  /** Məqalə kartları/sətirləri */
  item: string;
  /** item daxilində link (href) */
  link: string;
  title?: string;
  date?: string;
}

/** Selektor əsaslı siyahı səhifəsi. */
export function parseHtmlList(html: string, baseUrl: string, cfg: HtmlListConfig): FeedItem[] {
  const $ = cheerio.load(html);
  const out: FeedItem[] = [];
  $(cfg.item).each((_, el) => {
    const a = $(el).find(cfg.link).first();
    const href = a.attr('href');
    if (!href) return;
    let url: string;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    const title = (cfg.title ? $(el).find(cfg.title).first().text() : a.text())
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) return;
    out.push({
      title,
      url,
      publishedAt: cfg.date
        ? date(
            $(el).find(cfg.date).first().attr('datetime') ??
              $(el).find(cfg.date).first().text().trim(),
          )
        : null,
      summary: null,
    });
  });
  return out;
}

export interface HtmlDocumentConfig {
  /** Əsas mətn konteyneri */
  content: string;
  title?: string;
  /** Çıxarılacaq elementlər (nav, script, …) */
  remove?: string[];
}

/** Məqalə/qanun səhifəsindən təmiz mətn (abzas sərhədləri qorunur). */
export function extractDocumentText(
  html: string,
  cfg: HtmlDocumentConfig,
): { title: string | null; text: string } {
  const $ = cheerio.load(html);
  $('script, style, noscript, iframe, form').remove();
  for (const sel of cfg.remove ?? []) $(sel).remove();
  const root = $(cfg.content).first();
  if (root.length === 0) throw new Error(`Content selector "${cfg.content}" matched nothing`);
  const blocks: string[] = [];
  root.find('h1,h2,h3,h4,h5,h6,p,li,tr,blockquote,pre').each((_, el) => {
    if ($(el).find('p,li,tr,blockquote,pre').length > 0 && el.tagName !== 'tr') return; // yalnız yarpaq blokları
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t) blocks.push(t);
  });
  const text = (blocks.length ? blocks : [root.text().replace(/\s+/g, ' ').trim()]).join('\n\n');
  const title = cfg.title ? $(cfg.title).first().text().replace(/\s+/g, ' ').trim() || null : null;
  return { title, text };
}
