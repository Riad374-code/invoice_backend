import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';

export interface Table {
  sheet: string;
  headers: string[];
  rows: string[][];
  truncated: boolean;
}

export const MAX_ROWS = 50_000;

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return String(v); // ən qısa dəqiq təsvir (0.1 → "0.1")
  if (typeof v === 'object') {
    if ('result' in v && v.result !== undefined) return cellText(v.result as ExcelJS.CellValue); // düstur → nəticə
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('error' in v) return '';
  }
  return String(v).trim();
}

/** XLSX/CSV → cədvəl (ilk vərəq, ilk sətir başlıq). Ölçü limiti; bütün dəyərlər string. */
export async function readTable(buffer: Buffer, kind: 'xlsx' | 'csv'): Promise<Table> {
  const wb = new ExcelJS.Workbook();
  let ws: ExcelJS.Worksheet | undefined;
  if (kind === 'csv') {
    ws = await wb.csv.read(Readable.from(buffer), {
      // CSV dəyərləri OLDUĞU KİMİ qalır: tarix/ədəd avtomatik çevrilmir (saat qurşağı sürüşməsi, baş sıfırların itməsi)
      dateFormats: [],
      map: (value: unknown) => (value === null || value === undefined ? '' : String(value)),
      parserOptions: { delimiter: detectDelimiter(buffer) },
    });
  } else {
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    ws = wb.worksheets[0];
  }
  if (!ws) throw new Error('Workbook has no sheets');
  const all: string[][] = [];
  let truncated = false;
  ws.eachRow({ includeEmpty: false }, (row) => {
    if (all.length > MAX_ROWS) {
      truncated = true;
      return;
    }
    const vals = (row.values as ExcelJS.CellValue[]).slice(1).map(cellText);
    all.push(vals);
  });
  if (all.length === 0) throw new Error('Sheet is empty');
  const headers = all[0]!.map((h, i) => h.trim() || `column_${i + 1}`);
  const width = headers.length;
  return {
    sheet: ws.name,
    headers,
    rows: all.slice(1).map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? '').trim())),
    truncated,
  };
}

function detectDelimiter(buf: Buffer): string {
  const head = buf.subarray(0, 2000).toString('utf8').split('\n')[0] ?? '';
  const counts: Array<[string, number]> = [
    [',', 0],
    [';', 0],
    ['\t', 0],
  ];
  for (const c of counts) c[1] = head.split(c[0]).length - 1;
  return counts.sort((a, b) => b[1] - a[1])[0]![0];
}

export interface SheetSpec {
  name: string;
  headers: string[];
  rows: Array<Array<string | number | null>>;
}

/** Yeni XLSX; bütün dəyərlər mətn kimi yazılır (məbləğlər float-a çevrilməsin, VÖEN-də başdakı sıfır itməsin; mətn xanası düstur kimi icra olunmur). */
export async function writeWorkbook(sheets: SheetSpec[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LexAudit AI';
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31));
    ws.addRow(s.headers).font = { bold: true };
    for (const r of s.rows) ws.addRow(r.map((v) => (v === null ? '' : String(v))));
    ws.columns.forEach((c, i) => {
      c.width = Math.min(60, Math.max(10, (s.headers[i]?.length ?? 8) + 2));
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
