import { assertLocalDate, compareDates, type LocalDate } from './dates.js';
import { AccountingError } from './errors.js';
import { D, HUNDRED, type Dec } from './money.js';

export const TAX_TYPES = [
  'VAT',
  'PROFIT',
  'INCOME',
  'WITHHOLDING',
  'SIMPLIFIED',
  'SOCIAL',
] as const;
export type TaxType = (typeof TAX_TYPES)[number];

/** ƏDV rejimi: tutulan / sıfır dərəcə (0%) / azadolma. Sıfır dərəcə ≠ azadolma (əvəzləşdirmə hüququ fərqlidir). */
export type VatTreatment = 'taxable' | 'zero_rated' | 'exempt';

/** `tax_rates` cədvəlinin bir sətri. Dərəcə kodda deyil, DB-dədir (§6.1). */
export interface TaxRate {
  id: string;
  taxType: TaxType;
  code: string;
  /** Faizlə: 18 = 18%. */
  ratePercent: Dec;
  validFrom: LocalDate;
  /** Daxil olmaqla son gün; null = açıq. */
  validTo: LocalDate | null;
  legalSourceId: string | null;
  status: 'proposed' | 'active';
  /** Yalnız VAT üçün. Verilməyibsə: dərəcə > 0 → taxable, 0 → zero_rated. */
  treatment?: VatTreatment | null;
}

export function vatTreatmentOf(rate: TaxRate): VatTreatment {
  if (rate.treatment) return rate.treatment;
  return rate.ratePercent.gt(0) ? 'taxable' : 'zero_rated';
}

export function ratioOf(rate: TaxRate): Dec {
  return rate.ratePercent.div(HUNDRED);
}

function isEffective(rate: TaxRate, date: LocalDate): boolean {
  return (
    rate.status === 'active' &&
    compareDates(rate.validFrom, date) <= 0 &&
    (rate.validTo === null || compareDates(date, rate.validTo) <= 0)
  );
}

/**
 * Əməliyyat tarixində qüvvədə olan DƏRƏCƏ. `proposed` dərəcələr nəzərə alınmır.
 * Tapılmasa və ya bir neçə dərəcə üst-üstə düşsə — susmur, xəta atır (səhv dərəcə ilə saxta hesablama olmaz).
 */
export function selectRate(
  rates: readonly TaxRate[],
  taxType: TaxType,
  code: string,
  date: string,
): TaxRate {
  assertLocalDate(date, 'operation date');
  const matches = rates.filter(
    (r) => r.taxType === taxType && r.code === code && isEffective(r, date),
  );
  if (matches.length === 0) {
    throw new AccountingError(
      'RATE_NOT_FOUND',
      `No active ${taxType} rate "${code}" in effect on ${date}`,
    );
  }
  if (matches.length > 1) {
    throw new AccountingError(
      'RATE_AMBIGUOUS',
      `${matches.length} overlapping ${taxType} rates "${code}" are in effect on ${date}: ${matches.map((m) => m.id).join(', ')}`,
    );
  }
  const rate = matches[0]!;
  if (rate.ratePercent.lt(0) || rate.ratePercent.gt(HUNDRED)) {
    throw new AccountingError('INVALID_RATE', `Rate "${code}" (${rate.id}) is outside 0..100%`);
  }
  return rate;
}

/** Test/seed köməkçisi: string-lərdən TaxRate qurur. */
export function taxRate(input: {
  id: string;
  taxType: TaxType;
  code: string;
  ratePercent: string;
  validFrom: LocalDate;
  validTo?: LocalDate | null;
  legalSourceId?: string | null;
  status?: 'proposed' | 'active';
  treatment?: VatTreatment | null;
}): TaxRate {
  return {
    id: input.id,
    taxType: input.taxType,
    code: input.code,
    ratePercent: new D(input.ratePercent),
    validFrom: assertLocalDate(input.validFrom),
    validTo: input.validTo ? assertLocalDate(input.validTo) : null,
    legalSourceId: input.legalSourceId ?? null,
    status: input.status ?? 'active',
    treatment: input.treatment ?? null,
  };
}
