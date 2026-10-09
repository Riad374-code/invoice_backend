import { addDays, assertLocalDate, compareDates, daysBetween, type LocalDate } from './dates.js';
import { AccountingError } from './errors.js';
import { D, assertCurrency, dec, formatAmount, type AmountInput, type Dec } from './money.js';
import { DEFAULT_ROUNDING, round, type RoundingRule } from './rounding.js';

/** Bir valyutanın AZN qarşılığı: `nominal` vahid xarici valyuta = `rate` AZN (CBAR rəsmi məzənnəsi). */
export interface FxRate {
  currency: string;
  date: LocalDate;
  rate: Dec;
  /** CBAR bəzi valyutaları 100/1000 vahidə görə elan edir. */
  nominal: number;
  source: string;
}

export interface ConvertOptions {
  baseCurrency?: string;
  /** Verilmiş gündə məzənnə yoxdursa (həftə sonu/bayram) geriyə maksimum neçə gün baxılır. */
  maxStaleDays?: number;
  rounding?: RoundingRule;
}

export interface ConversionResult {
  amount: Dec;
  currency: string;
  from: string;
  to: string;
  /** İstifadə olunan məzənnələr (hansı tarixdən). */
  ratesUsed: Array<{
    currency: string;
    date: LocalDate;
    rate: Dec;
    nominal: number;
    source: string;
  }>;
  explanation: string[];
}

function rateFor(
  table: readonly FxRate[],
  currency: string,
  date: LocalDate,
  maxStaleDays: number,
): FxRate {
  const earliest = addDays(date, -maxStaleDays);
  const candidates = table.filter(
    (r) =>
      r.currency === currency &&
      compareDates(r.date, date) <= 0 &&
      compareDates(r.date, earliest) >= 0,
  );
  if (candidates.length === 0) {
    throw new AccountingError(
      'FX_RATE_NOT_FOUND',
      `No ${currency} exchange rate on ${date} (looked back ${maxStaleDays} days)`,
    );
  }
  const latest = candidates.reduce((a, b) => (compareDates(a.date, b.date) >= 0 ? a : b)).date;
  const sameDay = candidates.filter((r) => r.date === latest);
  const first = sameDay[0]!;
  if (sameDay.some((r) => !r.rate.eq(first.rate) || r.nominal !== first.nominal)) {
    throw new AccountingError(
      'RATE_AMBIGUOUS',
      `Conflicting ${currency} exchange rates on ${latest}`,
    );
  }
  if (first.rate.lte(0) || !Number.isInteger(first.nominal) || first.nominal < 1) {
    throw new AccountingError('INVALID_RATE', `Invalid ${currency} exchange rate on ${latest}`);
  }
  return first;
}

/**
 * Valyuta çevirməsi. Hər iki istiqamət baza valyuta (AZN) üzərindən keçir; aralıq nəticə
 * yuvarlaqlaşdırılmır, yalnız yekun məbləğ hədəf valyutanın dəqiqliyinə yuvarlaqlaşdırılır.
 */
export function convert(
  amount: AmountInput,
  from: string,
  to: string,
  date: LocalDate,
  table: readonly FxRate[],
  opts: ConvertOptions = {},
): ConversionResult {
  assertLocalDate(date, 'conversion date');
  const base = assertCurrency(opts.baseCurrency ?? 'AZN');
  const maxStale = opts.maxStaleDays ?? 7;
  const rounding = opts.rounding ?? DEFAULT_ROUNDING;
  const src = assertCurrency(from);
  const dst = assertCurrency(to);
  const value = dec(amount, 'amount');

  const result = (
    out: Dec,
    used: ConversionResult['ratesUsed'],
    explanation: string[],
  ): ConversionResult => ({
    amount: round(out, rounding),
    currency: dst,
    from: src,
    to: dst,
    ratesUsed: used,
    explanation,
  });

  if (src === dst) return result(value, [], [`Same currency (${src}); no conversion`]);

  const used: ConversionResult['ratesUsed'] = [];
  const explanation: string[] = [];
  let inBase = value;

  if (src !== base) {
    const r = rateFor(table, src, date, maxStale);
    used.push({ currency: src, date: r.date, rate: r.rate, nominal: r.nominal, source: r.source });
    inBase = value.mul(r.rate).div(new D(r.nominal));
    explanation.push(
      `${formatAmount(value)} ${src} × ${r.rate.toString()} ${base} / ${r.nominal} = ${inBase.toString()} ${base} (${r.source} rate of ${r.date}${
        r.date !== date ? `, ${daysBetween(r.date, date)} day(s) before ${date}` : ''
      })`,
    );
  }
  let out = inBase;
  if (dst !== base) {
    const r = rateFor(table, dst, date, maxStale);
    used.push({ currency: dst, date: r.date, rate: r.rate, nominal: r.nominal, source: r.source });
    out = inBase.mul(new D(r.nominal)).div(r.rate);
    explanation.push(
      `${inBase.toString()} ${base} × ${r.nominal} / ${r.rate.toString()} = ${out.toString()} ${dst} (${r.source} rate of ${r.date}${
        r.date !== date ? `, ${daysBetween(r.date, date)} day(s) before ${date}` : ''
      })`,
    );
  }
  return result(out, used, explanation);
}
