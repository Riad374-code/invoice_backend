/** SQL `az_normalize()` ilə EYNİ qayda (ə ı ö ü ç ş ğ → ASCII, kiçik hərf, birləşdirici nöqtənin silinməsi). */
export function azNormalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/̇/g, '')
    .replace(
      /[əıöüçşğ]/g,
      (c) => ({ ə: 'e', ı: 'i', ö: 'o', ü: 'u', ç: 'c', ş: 's', ğ: 'g' })[c as 'ə'] ?? c,
    );
}

const MAX_TOKENS = 12;

/** AZ aqqlütinativdir (vergi → vergilər → vergiyə): uzun sözlərin son 3 hərfi atılır; dəqiqliyi rerank təmin edir. */
const stem = (t: string) => (t.length >= 6 ? t.slice(0, Math.max(4, t.length - 3)) : t);

/**
 * İstifadəçi sorğusundan `to_tsquery('simple', …)` üçün prefiks sorğusu: `vergi:* | edv:*`.
 * Yalnız hərf/rəqəm tokenləri buraxılır → tsquery operatorlarını (& | ! : ( ) ' \) yeritmək mümkün deyil.
 * Prefiks (`:*`) AZ morfologiyası üçün vacibdir (vergi / vergilər / vergiyə).
 */
export function buildPrefixQuery(query: string): string {
  const tokens = azNormalize(query).match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(tokens)]
    .slice(0, MAX_TOKENS)
    .map((t) => `${stem(t)}:*`)
    .join(' | ');
}
