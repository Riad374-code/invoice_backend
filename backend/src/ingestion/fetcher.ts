import dns from 'node:dns/promises';
import net from 'node:net';
import { parseRobots, type RobotsRules } from './robots.js';

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

/** Test üçün dəyişdirilə bilən HTTP interfeysi. */
export interface PageFetcher {
  get(url: string): Promise<FetchResult>;
}

export class FetchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchBlockedError';
  }
}

/** SSRF qoruması: loopback / private / link-local / metadata ünvanları qadağandır. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  return mapped ? isPrivateAddress(mapped[1]!) : false;
}

export interface SafeFetcherOptions {
  userAgent: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Eyni host-a ardıcıl sorğular arasında minimum interval (nəzakətli sorğu tezliyi). */
  minIntervalMs?: number;
  maxRedirects?: number;
  resolve?: (host: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Təhlükəsiz səhifə yükləyici: yalnız http(s); hər hop-da DNS nəticəsi private IP-dirsə rədd; redirect-ləri əl ilə izləyir;
 * ölçü və vaxt limiti; robots.txt-ə riayət; host üzrə sorğu tezliyi limiti.
 */
export class SafeFetcher implements PageFetcher {
  private readonly lastHit = new Map<string, number>();
  private readonly robots = new Map<string, Promise<RobotsRules>>();
  private readonly o: Required<
    Omit<SafeFetcherOptions, 'resolve' | 'fetchImpl' | 'sleep' | 'now'>
  > &
    Pick<SafeFetcherOptions, 'resolve' | 'fetchImpl' | 'sleep' | 'now'>;

  constructor(opts: SafeFetcherOptions) {
    this.o = {
      timeoutMs: 15_000,
      maxBytes: 5_000_000,
      minIntervalMs: 1_500,
      maxRedirects: 4,
      ...opts,
    };
  }

  private async assertPublic(u: URL): Promise<void> {
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
      throw new FetchBlockedError(`Blocked scheme ${u.protocol}`);
    if (u.username || u.password) throw new FetchBlockedError('Credentials in URL are not allowed');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const ips = net.isIP(host)
      ? [host]
      : await (
          this.o.resolve ??
          (async (h: string) => (await dns.lookup(h, { all: true })).map((r) => r.address))
        )(host);
    if (ips.length === 0 || ips.some(isPrivateAddress))
      throw new FetchBlockedError(`Blocked non-public address for ${host}`);
  }

  private async politeWait(host: string, extraDelayMs = 0): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    const wait = Math.max(
      0,
      (this.lastHit.get(host) ?? 0) + Math.max(this.o.minIntervalMs, extraDelayMs) - now,
    );
    if (wait > 0) await (this.o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(wait);
    this.lastHit.set(host, (this.o.now ?? Date.now)());
  }

  private async rawGet(url: string): Promise<FetchResult> {
    const f = this.o.fetchImpl ?? fetch;
    let current = new URL(url);
    for (let hop = 0; hop <= this.o.maxRedirects; hop++) {
      await this.assertPublic(current);
      const res = await f(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(this.o.timeoutMs),
        headers: {
          'user-agent': this.o.userAgent,
          accept:
            'text/html,application/xhtml+xml,application/xml,application/rss+xml,text/plain;q=0.8',
        },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location')!, current);
        continue;
      }
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > this.o.maxBytes) throw new FetchBlockedError('Response too large');
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const c of res.body ?? []) {
        total += (c as Uint8Array).length;
        if (total > this.o.maxBytes) throw new FetchBlockedError('Response too large');
        chunks.push(c as Uint8Array);
      }
      return {
        url: current.toString(),
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      };
    }
    throw new FetchBlockedError('Too many redirects');
  }

  private robotsFor(u: URL): Promise<RobotsRules> {
    const origin = u.origin;
    let p = this.robots.get(origin);
    if (!p) {
      p = this.rawGet(`${origin}/robots.txt`).then(
        (r) =>
          r.status === 200
            ? parseRobots(r.body, this.o.userAgent)
            : parseRobots('', this.o.userAgent),
        () => parseRobots('', this.o.userAgent),
      );
      this.robots.set(origin, p);
    }
    return p;
  }

  async get(url: string): Promise<FetchResult> {
    const u = new URL(url);
    await this.assertPublic(u);
    const robots = await this.robotsFor(u);
    if (!robots.allows(u.pathname + u.search))
      throw new FetchBlockedError(`robots.txt disallows ${u.pathname}`);
    await this.politeWait(u.host, (robots.crawlDelaySeconds ?? 0) * 1000);
    return this.rawGet(url);
  }
}
