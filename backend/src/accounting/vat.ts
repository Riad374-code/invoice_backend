import { type LocalDate } from './dates.js';
import { dec, formatAmount, type AmountInput, type Dec, ZERO, HUNDRED } from './money.js';
import { DEFAULT_ROUNDING, round, type RoundingRule } from './rounding.js';
import { ratioOf, selectRate, vatTreatmentOf, type TaxRate, type VatTreatment } from './rates.js';

export interface VatResult {
  rateCode: string;
  rateId: string;
  ratePercent: Dec;
  treatment: VatTreatment;
  net: Dec;
  vat: Dec;
  gross: Dec;
  /** Dərəcənin hüquqi əsası (legislation_documents / sources). */
  rateSourceId: string | null;
  /** Hesablama addımları — hansı dərəcə, hansı mənbə, hansı qayda (§6.1). */
  explanation: string[];
}

function describeRate(
  code: string,
  percent: Dec,
  treatment: VatTreatment,
  rate: TaxRate,
  date: LocalDate,
): string {
  const src = rate.legalSourceId
    ? `legal source ${rate.legalSourceId}`
    : 'no legal source recorded';
  return `Rate "${code}" = ${percent.toString()}% (${treatment}), id ${rate.id}, effective ${rate.validFrom}${
    rate.validTo ? `..${rate.validTo}` : '..open'
  } on ${date}; ${src}`;
}

/**
 * Xalis məbləğdən ƏDV: vat = round(net × rate), gross = net + vat.
 * Azadolma (exempt) və sıfır dərəcədə (zero_rated) ƏDV = 0, lakin rejim nəticədə saxlanılır
 * (bəyannamədə ayrı bəndlərdə göstərilir).
 */
export function calculate(
  net: AmountInput,
  rateCode: string,
  date: LocalDate,
  rates: readonly TaxRate[],
  rounding: RoundingRule = DEFAULT_ROUNDING,
): VatResult {
  const rate = selectRate(rates, 'VAT', rateCode, date);
  const treatment = vatTreatmentOf(rate);
  const explanation = [describeRate(rateCode, rate.ratePercent, treatment, rate, date)];

  const rawNet = dec(net, 'net');
  const netAmount = round(rawNet, rounding);
  if (!netAmount.eq(rawNet)) {
    explanation.push(
      `Net ${rawNet.toString()} rounded to ${formatAmount(netAmount, rounding.scale)} (${rounding.mode})`,
    );
  }

  let vat = ZERO;
  if (treatment === 'taxable') {
    const exact = netAmount.mul(ratioOf(rate));
    vat = round(exact, rounding);
    explanation.push(
      `VAT = net × ${rate.ratePercent.toString()}% = ${exact.toString()} → ${formatAmount(vat, rounding.scale)} (${rounding.mode}, scale ${rounding.scale})`,
    );
  } else {
    explanation.push(
      `VAT = 0 (${treatment === 'exempt' ? 'exempt from VAT' : 'zero-rated supply'})`,
    );
  }
  const gross = netAmount.plus(vat);
  explanation.push(`Gross = net + VAT = ${formatAmount(gross, rounding.scale)}`);

  return {
    rateCode,
    rateId: rate.id,
    ratePercent: rate.ratePercent,
    treatment,
    net: netAmount,
    vat,
    gross,
    rateSourceId: rate.legalSourceId,
    explanation,
  };
}

/**
 * Ümumi məbləğdən (ƏDV daxil) geriyə: vat = round(gross × r / (100 + r)), net = gross − vat.
 * ƏDV yuvarlaqlaşdırılır, net qalıq kimi tapılır → net + vat == gross HƏMİŞƏ dəqiq.
 */
export function reverse(
  gross: AmountInput,
  rateCode: string,
  date: LocalDate,
  rates: readonly TaxRate[],
  rounding: RoundingRule = DEFAULT_ROUNDING,
): VatResult {
  const rate = selectRate(rates, 'VAT', rateCode, date);
  const treatment = vatTreatmentOf(rate);
  const explanation = [describeRate(rateCode, rate.ratePercent, treatment, rate, date)];

  const rawGross = dec(gross, 'gross');
  const grossAmount = round(rawGross, rounding);
  if (!grossAmount.eq(rawGross)) {
    explanation.push(
      `Gross ${rawGross.toString()} rounded to ${formatAmount(grossAmount, rounding.scale)} (${rounding.mode})`,
    );
  }

  let vat = ZERO;
  if (treatment === 'taxable') {
    const exact = grossAmount.mul(rate.ratePercent).div(HUNDRED.plus(rate.ratePercent));
    vat = round(exact, rounding);
    explanation.push(
      `VAT = gross × r / (100 + r) = ${exact.toString()} → ${formatAmount(vat, rounding.scale)} (${rounding.mode})`,
    );
  } else {
    explanation.push(
      `VAT = 0 (${treatment === 'exempt' ? 'exempt from VAT' : 'zero-rated supply'})`,
    );
  }
  const net = grossAmount.minus(vat);
  explanation.push(`Net = gross − VAT = ${formatAmount(net, rounding.scale)}`);

  return {
    rateCode,
    rateId: rate.id,
    ratePercent: rate.ratePercent,
    treatment,
    net,
    vat,
    gross: grossAmount,
    rateSourceId: rate.legalSourceId,
    explanation,
  };
}
