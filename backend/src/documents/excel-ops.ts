import { D, type Dec } from '../accounting/index.js';
import { isLocalDate } from '../accounting/dates.js';

/** "1 234,50", "1.234,50", "1,234.50", "(100.00)", "-5 AZN" → "1234.50" ; tanınmazsa null. */
export function normalizeAmount(raw: string): string | null {
  let s = raw.replace(/\s/g, '').replace(/(AZN|USD|EUR|₼|\$|€|man\.?)/gi, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart: string;
  let frac = '';
  if (lastDot !== -1 && lastComma !== -1) {
    const dec = Math.max(lastDot, lastComma);
    intPart = s.slice(0, dec).replace(/[.,]/g, '');
    frac = s.slice(dec + 1);
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? '.' : ',';
    const parts = s.split(sep);
    const last = parts[parts.length - 1]!;
    if (parts.length > 2 || last.length === 3) {
      // yalnız min ayırıcısı ("1,234" / "1.234.567")
      if (parts.length > 2 && last.length !== 3) return null;
      intPart = parts.join('');
    } else {
      intPart = parts[0]!;
      frac = last;
    }
  } else intPart = s;
  if (!/^\d+$/.test(intPart || '0') || (frac && !/^\d+$/.test(frac))) return null;
  const out = `${intPart || '0'}${frac ? `.${frac}` : ''}`.replace(/^0+(?=\d)/, '');
  return `${neg && new D(out).gt(0) ? '-' : ''}${out}`;
}

/** dd.mm.yyyy, dd/mm/yyyy, yyyy-mm-dd → ISO (təqvimdə mövcud gün); əks halda null. */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(s);
  let iso: string | null = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  if (!iso) {
    m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
    if (m) iso = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  }
  return iso && isLocalDate(iso) ? iso : null;
}

export type ColumnType = 'number' | 'date' | 'text' | 'empty';

export interface ColumnProfile {
  name: string;
  type: ColumnType;
  nonEmpty: number;
  distinct: number;
  /** number: dəqiq Decimal cəmi/min/max (float yox) */
  sum?: string;
  min?: string;
  max?: string;
  samples: string[];
  unparsable: number;
}

export interface TableProfile {
  rows: number;
  emptyRows: number;
  duplicateRows: number;
  columns: ColumnProfile[];
}

const MAJORITY = 0.9;

export function inferColumnType(values: readonly string[]): {
  type: ColumnType;
  unparsable: number;
} {
  const filled = values.filter((v) => v !== '');
  if (filled.length === 0) return { type: 'empty', unparsable: 0 };
  const nums = filled.filter((v) => normalizeAmount(v) !== null).length;
  const dates = filled.filter((v) => normalizeDate(v) !== null).length;
  if (dates / filled.length >= MAJORITY) return { type: 'date', unparsable: filled.length - dates };
  if (nums / filled.length >= MAJORITY) return { type: 'number', unparsable: filled.length - nums };
  return { type: 'text', unparsable: 0 };
}

export function profileTable(headers: readonly string[], rows: readonly string[][]): TableProfile {
  const seen = new Set<string>();
  let dup = 0;
  let empty = 0;
  for (const r of rows) {
    if (r.every((c) => c === '')) {
      empty++;
      continue;
    }
    const k = JSON.stringify(r);
    if (seen.has(k)) dup++;
    else seen.add(k);
  }
  const columns = headers.map((name, i): ColumnProfile => {
    const values = rows.map((r) => r[i] ?? '');
    const { type, unparsable } = inferColumnType(values);
    const filled = values.filter((v) => v !== '');
    const col: ColumnProfile = {
      name,
      type,
      nonEmpty: filled.length,
      distinct: new Set(filled).size,
      samples: [...new Set(filled)].slice(0, 3),
      unparsable,
    };
    if (type === 'number') {
      const nums: Dec[] = filled
        .map((v) => normalizeAmount(v))
        .filter((v): v is string => v !== null)
        .map((v) => new D(v));
      col.sum = nums.reduce((a, b) => a.plus(b), new D(0)).toString();
      col.min = D.min(...nums).toString();
      col.max = D.max(...nums).toString();
    }
    return col;
  });
  return { rows: rows.length, emptyRows: empty, duplicateRows: dup, columns };
}

export interface CleanLog {
  trimmed: number;
  amountsNormalized: number;
  datesNormalized: number;
  emptyRowsRemoved: number;
  duplicatesRemoved: number;
  unparsedCells: number;
}

/** Təmizləmə: boşluqlar, rəqəm/tarix formatı (yalnız sütunun çoxluğu həmin tip olduqda), boş və (istəyə bağlı) təkrar sətirlər. Giriş dəyişmir. */
export function cleanTable(
  headers: readonly string[],
  rows: readonly string[][],
  opts: { dedupe: boolean },
): { rows: string[][]; log: CleanLog } {
  const log: CleanLog = {
    trimmed: 0,
    amountsNormalized: 0,
    datesNormalized: 0,
    emptyRowsRemoved: 0,
    duplicatesRemoved: 0,
    unparsedCells: 0,
  };
  const types = headers.map((_, i) => inferColumnType(rows.map((r) => r[i] ?? '')).type);
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const cells = headers.map((_, i) => {
      const raw = r[i] ?? '';
      let v = raw.replace(/\s+/g, ' ').trim();
      if (v !== raw) log.trimmed++;
      if (v === '') return v;
      if (types[i] === 'number') {
        const n = normalizeAmount(v);
        if (n === null) log.unparsedCells++;
        else if (n !== v) {
          v = n;
          log.amountsNormalized++;
        }
      } else if (types[i] === 'date') {
        const d = normalizeDate(v);
        if (d === null) log.unparsedCells++;
        else if (d !== v) {
          v = d;
          log.datesNormalized++;
        }
      }
      return v;
    });
    if (cells.every((c) => c === '')) {
      log.emptyRowsRemoved++;
      continue;
    }
    if (opts.dedupe) {
      const k = JSON.stringify(cells);
      if (seen.has(k)) {
        log.duplicatesRemoved++;
        continue;
      }
      seen.add(k);
    }
    out.push(cells);
  }
  return { rows: out, log };
}
