import { D } from '../accounting/index.js';
import { normalizeAmount, normalizeDate } from '../documents/excel-ops.js';
import { azNormalize } from '../rag/query.js';
import { validateVoen } from '../accounting/tax-id.js';

export type ImportSource = '1c' | 'etaxes' | 'bank';

export interface InvoiceRowData {
  kind: 'invoice';
  direction: 'sales' | 'purchase';
  number: string;
  issueDate: string;
  counterpartyName: string;
  counterpartyVoen: string | null;
  net: string;
  vat: string;
  gross: string;
  currency: string;
  vatPercent: string | null;
  /** e-qaimə XML-də sətirlər olur; 1C cədvəlində yoxdur (tək sətir kimi yaradılır) */
  lines?: Array<{
    description: string;
    qty: string;
    unitPrice: string;
    vatRateCode: string;
    net: string;
    vat: string;
  }>;
}
export interface BankRowData {
  kind: 'bank';
  date: string;
  amount: string;
  description: string | null;
  reference: string | null;
  counterpartyVoen: string | null;
}
export interface PreviewRow {
  row: number;
  ok: boolean;
  errors: string[];
  data: InvoiceRowData | BankRowData | null;
}
export interface Preview {
  template: string;
  rows: PreviewRow[];
  rowsOk: number;
  rowsFailed: number;
  truncated: boolean;
}

const norm = (h: string) => azNormalize(h).replace(/[^\p{L}\p{N}]/gu, '');

/** Versiyalı başlıq şablonları: yeni export formatı = yeni versiya (köhnələr dəyişmir). */
const ALIASES = {
  'onec-table-v1': {
    number: ['number', 'nomre', 'senedno', 'qaimenomresi', 'faktura', 'no'],
    date: ['date', 'tarix', 'senedtarixi'],
    name: ['counterparty', 'kontragent', 'terefmuqabil', 'ad', 'name'],
    voen: ['voen', 'taxid', 'inn'],
    net: ['net', 'xalis', 'edvsiz', 'meblegedvsiz', 'amountnet'],
    vat: ['vat', 'edv', 'edvmebleqi', 'edvmeblegi'],
    gross: ['gross', 'cemi', 'umumi', 'edvile', 'total'],
    direction: ['direction', 'novu', 'nov', 'istiqamet'],
    currency: ['currency', 'valyuta'],
  },
  'bank-table-v1': {
    date: ['date', 'tarix', 'emeliyyattarixi'],
    amount: ['amount', 'mebleg', 'mebleqaz'],
    debit: ['debit', 'debet', 'cixis'],
    credit: ['credit', 'kredit', 'giris'],
    description: ['description', 'teyinat', 'aciqlama', 'details'],
    reference: ['reference', 'referans', 'ref', 'senedno', 'nomre', 'number'],
    voen: ['voen', 'counterpartyvoen'],
  },
} as const;

function mapHeaders<T extends Record<string, readonly string[]>>(
  headers: readonly string[],
  aliases: T,
): Partial<Record<keyof T, number>> {
  const nh = headers.map(norm);
  const out: Partial<Record<keyof T, number>> = {};
  for (const key of Object.keys(aliases) as Array<keyof T>) {
    const idx = nh.findIndex((h) => aliases[key]!.includes(h));
    if (idx !== -1) out[key] = idx;
  }
  return out;
}

const MAX_STORED = 5000;
const finish = (template: string, rows: PreviewRow[], truncated: boolean): Preview => ({
  template,
  rows: rows.slice(0, MAX_STORED),
  rowsOk: rows.filter((r) => r.ok).length,
  rowsFailed: rows.filter((r) => !r.ok).length,
  truncated: truncated || rows.length > MAX_STORED,
});

const SALES = new Set(['sales', 'satis', 'satış', 'cixan', 'çıxan']);
const PURCHASE = new Set(['purchase', 'alis', 'alış', 'daxil', 'daxilolan']);

export function previewOnecTable(
  headers: readonly string[],
  rows: readonly string[][],
  opts: { defaultDirection?: 'sales' | 'purchase'; truncated?: boolean },
): Preview {
  const m = mapHeaders(headers, ALIASES['onec-table-v1']);
  const missing = (['number', 'date', 'name', 'net', 'vat'] as const).filter(
    (k) => m[k] === undefined,
  );
  if (missing.length) {
    return finish(
      'onec-table-v1',
      [
        {
          row: 1,
          ok: false,
          errors: [`Missing required column(s): ${missing.join(', ')}`],
          data: null,
        },
      ],
      false,
    );
  }
  const out: PreviewRow[] = rows.map((r, i) => {
    const errors: string[] = [];
    const cell = (k: keyof typeof m) => (m[k] === undefined ? '' : (r[m[k]!] ?? '').trim());
    const number = cell('number');
    const date = normalizeDate(cell('date'));
    const net = normalizeAmount(cell('net'));
    const vat = normalizeAmount(cell('vat'));
    const grossRaw = cell('gross');
    const gross = grossRaw
      ? normalizeAmount(grossRaw)
      : net !== null && vat !== null
        ? new D(net).plus(vat).toFixed(2)
        : null;
    const voenRaw = cell('voen');
    if (!number) errors.push('number is empty');
    if (!date) errors.push(`invalid date "${cell('date')}"`);
    if (net === null) errors.push(`invalid net "${cell('net')}"`);
    if (vat === null) errors.push(`invalid VAT "${cell('vat')}"`);
    if (gross === null && grossRaw) errors.push(`invalid gross "${grossRaw}"`);
    if (!cell('name')) errors.push('counterparty name is empty');
    if (voenRaw && !validateVoen(voenRaw).valid) errors.push(`invalid VÖEN "${voenRaw}"`);
    const dirRaw = azNormalize(cell('direction'));
    const direction = SALES.has(dirRaw)
      ? 'sales'
      : PURCHASE.has(dirRaw)
        ? 'purchase'
        : !dirRaw
          ? opts.defaultDirection
          : undefined;
    if (!direction)
      errors.push(
        dirRaw
          ? `unknown direction "${dirRaw}"`
          : 'direction is missing (no column and no default)',
      );
    if (errors.length || !date || net === null || vat === null || gross === null || !direction)
      return { row: i + 2, ok: false, errors, data: null };
    const pct = new D(net).isZero()
      ? null
      : new D(vat).div(net).mul(100).toDecimalPlaces(2).toString();
    const cur = cell('currency').toUpperCase();
    return {
      row: i + 2,
      ok: true,
      errors: [],
      data: {
        kind: 'invoice',
        direction,
        number,
        issueDate: date,
        counterpartyName: cell('name'),
        counterpartyVoen: voenRaw ? validateVoen(voenRaw).normalized! : null,
        net,
        vat,
        gross,
        currency: /^[A-Z]{3}$/.test(cur) ? cur : 'AZN',
        vatPercent: pct,
      },
    };
  });
  return finish('onec-table-v1', out, opts.truncated ?? false);
}

export function previewBankTable(
  headers: readonly string[],
  rows: readonly string[][],
  opts: { truncated?: boolean },
): Preview {
  const m = mapHeaders(headers, ALIASES['bank-table-v1']);
  if (
    m.date === undefined ||
    (m.amount === undefined && m.debit === undefined && m.credit === undefined)
  ) {
    return finish(
      'bank-table-v1',
      [
        {
          row: 1,
          ok: false,
          errors: ['Missing required column(s): date and amount (or debit/credit)'],
          data: null,
        },
      ],
      false,
    );
  }
  const out: PreviewRow[] = rows.map((r, i) => {
    const errors: string[] = [];
    const cell = (k: keyof typeof m) => (m[k] === undefined ? '' : (r[m[k]!] ?? '').trim());
    const date = normalizeDate(cell('date'));
    let amount: string | null;
    if (m.amount !== undefined) amount = normalizeAmount(cell('amount'));
    else {
      const d = cell('debit') ? normalizeAmount(cell('debit')) : '0';
      const c = cell('credit') ? normalizeAmount(cell('credit')) : '0';
      amount = d === null || c === null ? null : new D(c).minus(d).toString(); // giriş (+) / çıxış (−)
    }
    if (!date) errors.push(`invalid date "${cell('date')}"`);
    if (amount === null) errors.push('invalid amount');
    else if (new D(amount).isZero()) errors.push('amount is zero');
    const voen = cell('voen');
    if (voen && !validateVoen(voen).valid) errors.push(`invalid VÖEN "${voen}"`);
    if (errors.length || !date || amount === null)
      return { row: i + 2, ok: false, errors, data: null };
    return {
      row: i + 2,
      ok: true,
      errors: [],
      data: {
        kind: 'bank',
        date,
        amount: new D(amount).toFixed(2),
        description: cell('description') || null,
        reference: cell('reference') || null,
        counterpartyVoen: voen ? validateVoen(voen).normalized! : null,
      },
    };
  });
  return finish('bank-table-v1', out, opts.truncated ?? false);
}
