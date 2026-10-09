const TRACKING = /^(utm_[a-z]+|fbclid|gclid|yclid|mc_cid|mc_eid|ref|ref_src|_ga)$/i;

/** Dedupe üçün kanonik URL: host kiçik hərf, fraqment/izləmə parametrləri atılır, query sıralanır, trailing slash yoxdur. */
export function canonicalizeUrl(raw: string, base?: string): string {
  const u = new URL(raw, base);
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new Error(`Unsupported URL scheme: ${u.protocol}`);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80'))
    u.port = '';
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.toString();
}

/** Bağlantı mənbənin öz domeninə (və ya alt domenlərinə) aiddirmi? Kənar linkləri izləməmək üçün (SSRF/scope). */
export function sameSite(candidate: string, sourceUrl: string): boolean {
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, '');
  const a = strip(new URL(candidate).hostname);
  const b = strip(new URL(sourceUrl).hostname);
  return a === b || a.endsWith(`.${b}`);
}
