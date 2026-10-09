import { isLocalDate, type LocalDate } from './dates.js';
import { AccountingError } from './errors.js';
import { D, ZERO, dec, formatAmount, sum, type AmountInput, type Dec } from './money.js';
import { DEFAULT_ROUNDING, round, type RoundingRule } from './rounding.js';
import { selectRate, vatTreatmentOf, type TaxRate, type VatTreatment } from './rates.js';
import { validateVoen } from './tax-id.js';
import * as vat from './vat.js';

export interface InvoiceLineInput {
  description: string;
  qty: AmountInput;
  unitPrice: AmountInput;
  vatRateCode: string;
  net: AmountInput;
  vat: AmountInput;
  accountFinal?: string | null;
}

export interface InvoiceInput {
  direction: 'sales' | 'purchase';
  number: string;
  issueDate: string;
  counterparty: { voen?: string | null; isVatPayer?: boolean | null };
  currency: string;
  net: AmountInput;
  vat: AmountInput;
  gross: AmountInput;
  lines: readonly InvoiceLineInput[];
}

export type InvoiceIssueCode =
  | 'INVALID_DATE'
  | 'FUTURE_DATE'
  | 'INVALID_AMOUNT'
  | 'NO_LINES'
  | 'INVALID_TAX_ID'
  | 'RATE_NOT_FOUND'
  | 'RATE_CONFIG_ERROR'
  | 'LINE_NET_MISMATCH'
  | 'VAT_RATE_MISMATCH'
  | 'TOTAL_MISMATCH'
  | 'VAT_FROM_NON_PAYER'
  | 'DUPLICATE_INVOICE';

export interface InvoiceIssue {
  code: InvoiceIssueCode;
  severity: 'error' | 'warning';
  message: string;
  lineIndex?: number;
  field?: string;
}

export interface ExistingInvoiceRef {
  id: string;
  direction: 'sales' | 'purchase';
  number: string;
  counterpartyVoen: string | null;
}

export interface CheckContext {
  rates: readonly TaxRate[];
  rounding?: RoundingRule;
  /** Sətir başına qəbul olunan yuvarlaqlaşdırma fərqi (default 0.01). Cəmlər üçün sətir sayı ilə vurulur. */
  tolerance?: AmountInput;
  /** Gələcək tarix yoxlaması üçün "bu gün" (default: sistem tarixi deyil — verilməsə yoxlanmır, mühərrik təmiz qalır). */
  today?: LocalDate;
  existing?: readonly ExistingInvoiceRef[];
}

const normNumber = (n: string) => n.toUpperCase().replace(/\s+/g, '');

/**
 * Qaimənin deterministik yoxlanması: cəmlər, ƏDV dərəcəsi, tarix, VÖEN, dublikat.
 * AI çıxarışından gələn məlumat da buradan keçir — nəticə `invoice_issues`-ə yazılır.
 */
export function check(invoice: InvoiceInput, ctx: CheckContext): InvoiceIssue[] {
  const issues: InvoiceIssue[] = [];
  const rounding = ctx.rounding ?? DEFAULT_ROUNDING;
  const tolerance = dec(ctx.tolerance ?? '0.01', 'tolerance');
  const add = (i: InvoiceIssue) => void issues.push(i);

  // tarix
  const dateOk = isLocalDate(invoice.issueDate);
  if (!dateOk) {
    add({
      code: 'INVALID_DATE',
      severity: 'error',
      field: 'issueDate',
      message: `"${invoice.issueDate}" is not a valid YYYY-MM-DD date`,
    });
  } else if (ctx.today && invoice.issueDate > ctx.today) {
    add({
      code: 'FUTURE_DATE',
      severity: 'warning',
      field: 'issueDate',
      message: `Issue date ${invoice.issueDate} is in the future`,
    });
  }

  // VÖEN
  if (invoice.counterparty.voen) {
    const r = validateVoen(invoice.counterparty.voen);
    if (!r.valid)
      add({
        code: 'INVALID_TAX_ID',
        severity: 'error',
        field: 'counterparty.voen',
        message: r.reason ?? 'Invalid VÖEN',
      });
  }

  if (invoice.lines.length === 0) {
    add({ code: 'NO_LINES', severity: 'error', field: 'lines', message: 'Invoice has no lines' });
  }

  // məbləğlər
  let headerNet: Dec, headerVat: Dec, headerGross: Dec;
  try {
    headerNet = dec(invoice.net, 'net');
    headerVat = dec(invoice.vat, 'vat');
    headerGross = dec(invoice.gross, 'gross');
  } catch (e) {
    add({ code: 'INVALID_AMOUNT', severity: 'error', message: (e as Error).message });
    return issues;
  }

  const lineNets: Dec[] = [];
  const lineVats: Dec[] = [];
  let lineAmountsOk = true;

  invoice.lines.forEach((line, i) => {
    let net: Dec, lineVat: Dec, qty: Dec, price: Dec;
    try {
      net = dec(line.net, `line ${i + 1} net`);
      lineVat = dec(line.vat, `line ${i + 1} vat`);
      qty = dec(line.qty, `line ${i + 1} qty`);
      price = dec(line.unitPrice, `line ${i + 1} unitPrice`);
    } catch (e) {
      lineAmountsOk = false;
      add({
        code: 'INVALID_AMOUNT',
        severity: 'error',
        lineIndex: i,
        message: (e as Error).message,
      });
      return;
    }
    lineNets.push(net);
    lineVats.push(lineVat);

    // qty × qiymət = net
    const expectedNet = round(qty.mul(price), rounding);
    if (net.minus(expectedNet).abs().gt(tolerance)) {
      add({
        code: 'LINE_NET_MISMATCH',
        severity: 'error',
        lineIndex: i,
        field: 'net',
        message: `Line ${i + 1}: qty × unit price = ${formatAmount(expectedNet)} but net is ${formatAmount(net)}`,
      });
    }

    // ƏDV dərəcəsi / məbləği — tarixdə qüvvədə olan dərəcə ilə
    if (!dateOk) return;
    try {
      const expected = vat.calculate(net, line.vatRateCode, invoice.issueDate, ctx.rates, rounding);
      if (lineVat.minus(expected.vat).abs().gt(tolerance)) {
        const implied = net.isZero()
          ? 'n/a'
          : `${lineVat.div(net).mul(100).toDecimalPlaces(2).toString()}%`;
        add({
          code: 'VAT_RATE_MISMATCH',
          severity: 'error',
          lineIndex: i,
          field: 'vat',
          message: `Line ${i + 1}: VAT ${formatAmount(lineVat)} does not match rate "${line.vatRateCode}" (${expected.ratePercent.toString()}%, ${expected.treatment}) on ${invoice.issueDate}: expected ${formatAmount(expected.vat)}, implied ${implied}`,
        });
      }
    } catch (e) {
      if (e instanceof AccountingError) {
        add({
          // dərəcə cədvəlinin özü səhvdir (üst-üstə düşmə/etibarsız faiz) → qaimə yox, konfiqurasiya problemi
          code: e.code === 'RATE_NOT_FOUND' ? 'RATE_NOT_FOUND' : 'RATE_CONFIG_ERROR',
          severity: 'error',
          lineIndex: i,
          field: 'vatRateCode',
          message: `Line ${i + 1}: ${e.message}`,
        });
      } else throw e;
    }
  });

  // cəmlər (sətir sayı qədər yuvarlaqlaşdırma fərqi qəbul olunur)
  if (lineAmountsOk && invoice.lines.length > 0) {
    const totalTol = tolerance.mul(new D(Math.max(1, invoice.lines.length)));
    const sumNet = sum(lineNets);
    const sumVat = sum(lineVats);
    if (sumNet.minus(headerNet).abs().gt(totalTol)) {
      add({
        code: 'TOTAL_MISMATCH',
        severity: 'error',
        field: 'net',
        message: `Sum of line nets ${formatAmount(sumNet)} ≠ invoice net ${formatAmount(headerNet)}`,
      });
    }
    if (sumVat.minus(headerVat).abs().gt(totalTol)) {
      add({
        code: 'TOTAL_MISMATCH',
        severity: 'error',
        field: 'vat',
        message: `Sum of line VAT ${formatAmount(sumVat)} ≠ invoice VAT ${formatAmount(headerVat)}`,
      });
    }
  }
  if (headerNet.plus(headerVat).minus(headerGross).abs().gt(tolerance)) {
    add({
      code: 'TOTAL_MISMATCH',
      severity: 'error',
      field: 'gross',
      message: `Net + VAT = ${formatAmount(headerNet.plus(headerVat))} ≠ gross ${formatAmount(headerGross)}`,
    });
  }

  // ƏDV ödəyicisi olmayandan ƏDV
  if (
    invoice.counterparty.isVatPayer === false &&
    invoice.direction === 'purchase' &&
    headerVat.gt(0)
  ) {
    add({
      code: 'VAT_FROM_NON_PAYER',
      severity: 'warning',
      field: 'vat',
      message: 'VAT is charged by a counterparty that is not registered as a VAT payer',
    });
  }

  // dublikat
  const voen = invoice.counterparty.voen ?? null;
  for (const other of ctx.existing ?? []) {
    if (
      other.direction === invoice.direction &&
      normNumber(other.number) === normNumber(invoice.number) &&
      (other.counterpartyVoen ?? null) === voen
    ) {
      add({
        code: 'DUPLICATE_INVOICE',
        severity: 'error',
        field: 'number',
        message: `Invoice ${invoice.number} from the same counterparty already exists (${other.id})`,
      });
      break;
    }
  }
  return issues;
}

// ---------------------------------------------------------------- totals

export interface TotalsLineInput {
  qty: AmountInput;
  unitPrice: AmountInput;
  vatRateCode: string;
}

export interface LineTotals {
  net: Dec;
  vat: Dec;
  gross: Dec;
  rateCode: string;
  treatment: VatTreatment;
}

export interface InvoiceTotals {
  lines: LineTotals[];
  net: Dec;
  vat: Dec;
  gross: Dec;
  /** Bəyannamə üçün: dərəcə kodu üzrə baza və ƏDV. */
  byRate: Record<string, { treatment: VatTreatment; net: Dec; vat: Dec }>;
}

/**
 * Sətirlərdən qaimə cəmləri. Yuvarlaqlaşdırma səviyyəsi konfiqurasiyadan:
 *  - `line`: hər sətrin ƏDV-si yuvarlaqlaşdırılır, cəm yuvarlaq sətirlərin cəmidir;
 *  - `total`: sətir ƏDV-ləri dəqiq toplanır, cəm bir dəfə yuvarlaqlaşdırılır (sətirlərdə qalıq paylanır).
 */
export function computeTotals(
  lines: readonly TotalsLineInput[],
  date: LocalDate,
  rates: readonly TaxRate[],
  rounding: RoundingRule = DEFAULT_ROUNDING,
): InvoiceTotals {
  const rows = lines.map((l) => {
    const rate = selectRate(rates, 'VAT', l.vatRateCode, date);
    const treatment = vatTreatmentOf(rate);
    const net = round(dec(l.qty, 'qty').mul(dec(l.unitPrice, 'unitPrice')), rounding);
    const exact = treatment === 'taxable' ? net.mul(rate.ratePercent).div(100) : ZERO;
    return { rate, treatment, net, exact };
  });

  let vats: Dec[];
  if (rounding.level === 'line') {
    vats = rows.map((r) => round(r.exact, rounding));
  } else {
    const total = round(sum(rows.map((r) => r.exact)), rounding);
    // sətirlərə: hər biri yuvarlaqlaşdırılır, fərq ən böyük qalıqlı sətirə əlavə olunur (cəm dəqiq qalır)
    vats = rows.map((r) => round(r.exact, rounding));
    const diff = total.minus(sum(vats));
    if (!diff.isZero() && rows.length > 0) {
      let idx = 0;
      let best = new D(-1);
      rows.forEach((r, i) => {
        const residue = r.exact.minus(vats[i]!).abs();
        if (residue.gt(best)) {
          best = residue;
          idx = i;
        }
      });
      vats[idx] = vats[idx]!.plus(diff);
    }
  }

  const out: LineTotals[] = rows.map((r, i) => ({
    net: r.net,
    vat: vats[i]!,
    gross: r.net.plus(vats[i]!),
    rateCode: r.rate.code,
    treatment: r.treatment,
  }));
  const byRate: InvoiceTotals['byRate'] = {};
  for (const l of out) {
    const slot = (byRate[l.rateCode] ??= { treatment: l.treatment, net: ZERO, vat: ZERO });
    slot.net = slot.net.plus(l.net);
    slot.vat = slot.vat.plus(l.vat);
  }
  const net = sum(out.map((l) => l.net));
  const vatTotal = sum(out.map((l) => l.vat));
  return { lines: out, net, vat: vatTotal, gross: net.plus(vatTotal), byRate };
}
