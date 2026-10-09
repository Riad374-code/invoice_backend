import type { DocumentKind } from '../domain/index.js';

export interface DetectedDocument {
  kind: DocumentKind;
  /** Məzmuna əsasən müəyyən edilmiş MIME (müştəri başlığına etibar edilmir). */
  mime: string;
}

export type DetectionResult = { ok: true; doc: DetectedDocument } | { ok: false; reason: string };

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Hər növ üçün müştərinin göndərə biləcəyi uyğun `Content-Type` dəyərləri. */
const COMPATIBLE_DECLARED: Record<DocumentKind, readonly string[]> = {
  pdf: ['application/pdf'],
  image: ['image/png', 'image/jpeg', 'image/tiff'],
  spreadsheet: [XLSX_MIME, 'application/vnd.ms-excel'],
  csv: ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'],
  xml: ['application/xml', 'text/xml'],
  text: ['text/plain'],
};

const startsWith = (buf: Buffer, bytes: readonly number[], offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i === -1 ? '' : fileName.slice(i + 1).toLowerCase();
}

/** UTF-8 BOM-u (U+FEFF) atır. */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function decodeUtf8(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

function sniff(buf: Buffer, fileName: string): DetectedDocument | { reason: string } {
  const ext = extensionOf(fileName);

  if (buf.subarray(0, 1024).includes('%PDF-')) return { kind: 'pdf', mime: 'application/pdf' };
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { kind: 'image', mime: 'image/png' };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg' };
  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { kind: 'image', mime: 'image/tiff' };
  }

  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    // ZIP konteyneri: yalnız .xlsx (OOXML) qəbul edilir
    if (ext === 'xlsx' && buf.includes('[Content_Types].xml') && buf.includes('xl/')) {
      return { kind: 'spreadsheet', mime: XLSX_MIME };
    }
    return { reason: 'ZIP archives are not accepted (only .xlsx workbooks)' };
  }
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return ext === 'xls'
      ? { kind: 'spreadsheet', mime: 'application/vnd.ms-excel' }
      : { reason: 'Legacy OLE documents are accepted only as .xls workbooks' };
  }

  // Mətn əsaslı formatlar: NUL baytı olmamalı və etibarlı UTF-8 olmalıdır
  if (buf.subarray(0, 8192).includes(0)) return { reason: 'Unrecognised binary content' };
  const text = decodeUtf8(buf);
  if (text === null) return { reason: 'Text files must be UTF-8 encoded' };
  const head = stripBom(text).trimStart();

  if (ext === 'xml') {
    return head.startsWith('<')
      ? { kind: 'xml', mime: 'application/xml' }
      : { reason: 'File is not well-formed XML' };
  }
  if (ext === 'csv') return { kind: 'csv', mime: 'text/csv' };
  if (ext === 'txt') return { kind: 'text', mime: 'text/plain' };
  return { reason: 'Unsupported file type' };
}

/**
 * MIME yoxlaması (§11): növ məzmunun "magic byte"-larından və uzantıdan müəyyən edilir;
 * müştərinin bəyan etdiyi Content-Type ziddiyyət təşkil edirsə fayl rədd olunur.
 */
export function detectDocument(
  buf: Buffer,
  fileName: string,
  declaredMime?: string,
): DetectionResult {
  if (buf.length === 0) return { ok: false, reason: 'File is empty' };
  const sniffed = sniff(buf, fileName);
  if ('reason' in sniffed) return { ok: false, reason: sniffed.reason };

  const declared = declaredMime?.split(';')[0]?.trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== 'binary/octet-stream') {
    if (!COMPATIBLE_DECLARED[sniffed.kind].includes(declared)) {
      return {
        ok: false,
        reason: `Declared content type "${declared}" does not match the file content (${sniffed.mime})`,
      };
    }
  }
  return { ok: true, doc: sniffed };
}
