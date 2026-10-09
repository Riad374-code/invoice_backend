import { extractText, getDocumentProxy } from 'unpdf';

export interface PdfText {
  text: string;
  pages: Array<{ page: number; chars: number }>;
}

/** Mətnli PDF-dən səhifə-səhifə mətn. Pozuq PDF xəta atır (çağıran `failed` yazır). */
export async function extractPdfText(buffer: Buffer): Promise<PdfText> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (text as unknown as string[]).map((t) => t.replace(/[ \t]+\n/g, '\n').trim());
  return {
    text: pages.join('\n\n'),
    pages: pages.map((t, i) => ({ page: i + 1, chars: t.length })),
  };
}

/** Səhifəyə düşən mətn çox azdırsa PDF skandır (şəkil) → OCR lazımdır. */
export function looksScanned(p: PdfText, minCharsPerPage = 30): boolean {
  if (p.pages.length === 0) return true;
  return p.text.replace(/\s+/g, '').length < minCharsPerPage * p.pages.length;
}
