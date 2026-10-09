export interface TextChunk {
  chunkNo: number;
  articleRef: string | null;
  text: string;
}

export interface ChunkOptions {
  /** Hədəf maksimum uzunluq (simvol). */
  maxChars?: number;
  /** Uzun maddə/abzas bölünəndə qonşu parçalar arası təkrar (simvol). */
  overlapChars?: number;
}

// "Maddə 12.", "Maddə 12-1.", "Madde 5" (ASCII), "Статья 7" (rus), "Article 3"
const ARTICLE_HEADING = /^\s*(Maddə|Madde|Статья|Article)\s+(\d+(?:[-.]\d+)*)\s*[.:)\-–—]?\s*/i;

/** Mətni `maxChars` ətrafında parçalara bölür; söz ortasından kəsmir, boş parça yaratmır. */
function splitLong(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      const cut = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('; '),
        window.lastIndexOf(' '),
      );
      if (cut > maxChars * 0.5) end = start + cut + 1;
    }
    out.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out.filter(Boolean);
}

/**
 * Qanun: "Maddə N" başlıqlarına görə bölünür (article_ref = "Maddə N"), uzun maddələr bölünür.
 * Başlıqsız mətn (xəbər, fayl): abzaslar `maxChars`-a qədər birləşdirilir.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const maxChars = opts.maxChars ?? 1200;
  const overlap = Math.min(opts.overlapChars ?? 150, Math.floor(maxChars / 3));
  const paragraphs = text
    .split(/\n{2,}|\r\n\r\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: TextChunk[] = [];
  const push = (articleRef: string | null, body: string) => {
    for (const piece of splitLong(body, maxChars, overlap))
      chunks.push({ chunkNo: chunks.length, articleRef, text: piece });
  };

  const hasArticles = paragraphs.some((p) => ARTICLE_HEADING.test(p));
  if (hasArticles) {
    let ref: string | null = null;
    let buf: string[] = [];
    const flush = () => {
      if (buf.length) push(ref, buf.join('\n\n'));
      buf = [];
    };
    for (const p of paragraphs) {
      const m = ARTICLE_HEADING.exec(p);
      if (m) {
        flush();
        const label = /^статья/i.test(m[1]!)
          ? 'Статья'
          : /^article/i.test(m[1]!)
            ? 'Article'
            : 'Maddə';
        ref = `${label} ${m[2]}`;
      }
      buf.push(p);
    }
    flush();
    return chunks;
  }

  let buf = '';
  for (const p of paragraphs) {
    if (buf && buf.length + p.length + 2 > maxChars) {
      push(null, buf);
      buf = '';
    }
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf) push(null, buf);
  return chunks;
}
