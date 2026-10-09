import {
  D,
  ZERO,
  formatAmount,
  fx,
  selectRate,
  vatTreatmentOf,
  addDays,
  type Dec,
  type TaxRate,
} from '../accounting/index.js';
import type { Repos } from '../db/index.js';

export interface PeriodSummary {
  period: string;
  from: string;
  to: string;
  outputVat: Dec;
  inputVat: Dec;
  exemptTurnover: Dec;
  zeroRatedTurnover: Dec;
  taxableTurnover: Dec;
  /** output − input (mənfi = geri qaytarılan/növbəti dövrə keçirilən) */
  payable: Dec;
  depositBalance: Dec | null;
  byRate: Array<{
    code: string;
    ratePercent: string;
    treatment: string;
    salesNet: Dec;
    salesVat: Dec;
    purchaseNet: Dec;
    purchaseVat: Dec;
  }>;
  included: { sales: number; purchases: number };
  /** Yoxlanmamış (extracted/needs_review) qaimələr — hesaba KATILMAYIB, mühasib görməlidir */
  excluded: Array<{ id: string; number: string; status: string }>;
  /** Hesablamanı tamamlamağa mane olanlar (məs. xarici valyuta üçün CBAR məzənnəsi yoxdur) */
  blockers: Array<{ invoiceId: string; number: string; reason: string }>;
  explanation: string[];
}

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function periodBounds(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const from = `${period}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { from, to: addDays(next, -1) };
}

/**
 * ƏDV dövrü yekunu — YALNIZ deterministik mühərrikdən və saxlanılmış, yoxlanmış qaimə məbləğlərindən.
 *  - yalnız `validated`/`posted` qaimələr; digərləri `excluded` kimi göstərilir
 *  - xarici valyuta: qaimə tarixinin CBAR məzənnəsi ilə AZN-ə çevrilir; məzənnə yoxdursa `blockers`
 */
export async function computePeriodSummary(
  repos: Repos,
  companyId: string,
  period: string,
): Promise<PeriodSummary> {
  const { from, to } = periodBounds(period);
  const rates = (await repos.taxRates.listActive('VAT')) as TaxRate[];
  const all = await repos.invoices.list(companyId, { from, to, limit: 10_000 });
  const invoices = all.slice(0, 10_000);

  const buckets = new Map<string, PeriodSummary['byRate'][number]>();
  const summary: PeriodSummary = {
    period,
    from,
    to,
    outputVat: ZERO,
    inputVat: ZERO,
    exemptTurnover: ZERO,
    zeroRatedTurnover: ZERO,
    taxableTurnover: ZERO,
    payable: ZERO,
    depositBalance: null,
    byRate: [],
    included: { sales: 0, purchases: 0 },
    excluded: [],
    blockers: [],
    explanation: [],
  };

  for (const inv of invoices) {
    if (inv.status === 'extracted' || inv.status === 'needs_review') {
      summary.excluded.push({ id: inv.id, number: inv.number, status: inv.status });
      continue;
    }
    const lines = await repos.invoices.lines(companyId, inv.id);
    let table: fx.FxRate[] = [];
    if (inv.currency !== 'AZN') {
      const rows = await repos.assistant.listFxRates(
        [inv.currency],
        inv.issueDate,
        addDays(inv.issueDate, -7),
      );
      table = rows.map((r) => ({
        currency: r.currency,
        date: r.date,
        rate: new D(r.rate),
        nominal: r.nominal,
        source: r.source,
      }));
    }
    const toAzn = (amount: string): Dec =>
      inv.currency === 'AZN'
        ? new D(amount)
        : fx.convert(amount, inv.currency, 'AZN', inv.issueDate, table).amount;
    try {
      const converted = lines.map((l) => {
        const rate = selectRate(rates, 'VAT', l.vatRateCode, inv.issueDate);
        return { l, rate, treatment: vatTreatmentOf(rate), net: toAzn(l.net), vat: toAzn(l.vat) };
      });
      for (const c of converted) {
        const b = buckets.get(c.l.vatRateCode) ?? {
          code: c.l.vatRateCode,
          ratePercent: c.rate.ratePercent.toString(),
          treatment: c.treatment,
          salesNet: ZERO,
          salesVat: ZERO,
          purchaseNet: ZERO,
          purchaseVat: ZERO,
        };
        if (inv.direction === 'sales') {
          b.salesNet = b.salesNet.plus(c.net);
          b.salesVat = b.salesVat.plus(c.vat);
          if (c.treatment === 'exempt') summary.exemptTurnover = summary.exemptTurnover.plus(c.net);
          else if (c.treatment === 'zero_rated')
            summary.zeroRatedTurnover = summary.zeroRatedTurnover.plus(c.net);
          else summary.taxableTurnover = summary.taxableTurnover.plus(c.net);
          summary.outputVat = summary.outputVat.plus(c.vat);
        } else {
          b.purchaseNet = b.purchaseNet.plus(c.net);
          b.purchaseVat = b.purchaseVat.plus(c.vat);
          summary.inputVat = summary.inputVat.plus(c.vat);
        }
        buckets.set(c.l.vatRateCode, b);
      }
      summary.included[inv.direction === 'sales' ? 'sales' : 'purchases']++;
    } catch (e) {
      summary.blockers.push({
        invoiceId: inv.id,
        number: inv.number,
        reason: (e as Error).message,
      });
    }
  }

  summary.byRate = [...buckets.values()].sort((a, b) => (a.code < b.code ? -1 : 1));
  summary.payable = summary.outputVat.minus(summary.inputVat);
  const dep = await repos.vat.depositBalance(companyId, to);
  summary.depositBalance = dep.lines > 0 ? new D(dep.balance) : null;
  summary.explanation = [
    `Period ${period} (${from}..${to}); ${summary.included.sales} sales and ${summary.included.purchases} purchase invoices included.`,
    `Output VAT = Σ VAT of sales lines = ${formatAmount(summary.outputVat)}; input VAT = Σ VAT of purchase lines = ${formatAmount(summary.inputVat)}.`,
    `Payable = output − input = ${formatAmount(summary.payable)}${summary.payable.isNegative() ? ' (refundable / carried forward)' : ''}.`,
    `Exempt turnover ${formatAmount(summary.exemptTurnover)} and zero-rated turnover ${formatAmount(summary.zeroRatedTurnover)} are reported separately (they carry no output VAT).`,
    ...(summary.excluded.length
      ? [
          `${summary.excluded.length} invoice(s) are not validated and are EXCLUDED — review them before filing.`,
        ]
      : []),
    ...(summary.blockers.length
      ? [
          `${summary.blockers.length} invoice(s) could not be converted/classified — the figures are INCOMPLETE.`,
        ]
      : []),
  ];
  return summary;
}

/** Bəyannamə qaralaması üçün CSV (UTF-8 BOM ilə — Excel Azərbaycan hərflərini düzgün açsın). */
export function summaryToCsv(
  s: PeriodSummary,
  meta: { company: string; voen: string; generatedAt: string; version: number },
): string {
  const q = (v: string) => `"${v.replaceAll('"', '""')}"`;
  const rows: string[][] = [
    ['LexAudit AI — VAT return DRAFT (not filed)'],
    ['Company', meta.company],
    ['VOEN', meta.voen],
    ['Period', s.period],
    ['Draft version', String(meta.version)],
    ['Generated at', meta.generatedAt],
    [],
    ['Item', 'Amount (AZN)'],
    ['Output VAT', formatAmount(s.outputVat)],
    ['Input VAT', formatAmount(s.inputVat)],
    ['Payable (output − input)', formatAmount(s.payable)],
    ['Taxable turnover', formatAmount(s.taxableTurnover)],
    ['Exempt turnover', formatAmount(s.exemptTurnover)],
    ['Zero-rated turnover', formatAmount(s.zeroRatedTurnover)],
    ['VAT deposit balance', s.depositBalance ? formatAmount(s.depositBalance) : 'n/a'],
    [],
    ['Rate code', 'Rate %', 'Treatment', 'Sales net', 'Sales VAT', 'Purchase net', 'Purchase VAT'],
    ...s.byRate.map((b) => [
      b.code,
      b.ratePercent,
      b.treatment,
      formatAmount(b.salesNet),
      formatAmount(b.salesVat),
      formatAmount(b.purchaseNet),
      formatAmount(b.purchaseVat),
    ]),
    [],
    ['Excluded (not validated)', String(s.excluded.length)],
    ...s.excluded.map((e) => [e.number, e.status]),
    [],
    ...s.explanation.map((e) => [e]),
  ];
  return '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}
