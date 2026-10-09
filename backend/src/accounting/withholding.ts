import { AccountingError } from './errors.js';
import { dec, formatAmount, HUNDRED, type AmountInput, type Dec } from './money.js';
import { selectRate } from './rates.js';
import { DEFAULT_ROUNDING, round, type RoundingRule } from './rounding.js';
import type { LocalDate } from './dates.js';
import type { TaxRate } from './rates.js';

export interface WithholdingResult {
  rateCode: string;
  rateId: string;
  ratePercent: Dec;
  /** Vergi tutulan baza (ödənişin ümumi məbləği). */
  base: Dec;
  /** Mənbədə tutulan vergi. */
  withheld: Dec;
  /** Alıcıya faktiki köçürülən məbləğ (base − withheld). */
  payable: Dec;
  rateSourceId: string | null;
  explanation: string[];
}

export type WithholdingBasis =
  /** `amount` = müqavilə üzrə ümumi ödəniş; vergi ondan tutulur, alıcı `amount − vergi` alır. */
  | 'gross_payment'
  /** `amount` = alıcının QƏTİ əlinə alacağı məbləğ; vergi ödəyicinin hesabınadır (gross-up). */
  | 'net_payment';

/** Ödəmə mənbəyində vergi (`WITHHOLDING` dərəcələri `tax_rates`-dən, tarixə görə). */
export function calculate(
  amount: AmountInput,
  rateCode: string,
  date: LocalDate,
  rates: readonly TaxRate[],
  rounding: RoundingRule = DEFAULT_ROUNDING,
  basis: WithholdingBasis = 'gross_payment',
): WithholdingResult {
  const rate = selectRate(rates, 'WITHHOLDING', rateCode, date);
  if (rate.ratePercent.gte(HUNDRED)) {
    throw new AccountingError('INVALID_RATE', `Withholding rate "${rateCode}" must be below 100%`);
  }
  const amt = round(dec(amount, 'amount'), rounding);
  const explanation = [
    `Withholding rate "${rateCode}" = ${rate.ratePercent.toString()}%, id ${rate.id}, effective ${rate.validFrom}${
      rate.validTo ? `..${rate.validTo}` : '..open'
    } on ${date}`,
  ];

  let base: Dec;
  let withheld: Dec;
  if (basis === 'gross_payment') {
    base = amt;
    withheld = round(base.mul(rate.ratePercent).div(HUNDRED), rounding);
    explanation.push(
      `Tax = payment × ${rate.ratePercent.toString()}% → ${formatAmount(withheld, rounding.scale)}`,
    );
  } else {
    base = round(amt.mul(HUNDRED).div(HUNDRED.minus(rate.ratePercent)), rounding);
    withheld = base.minus(amt);
    explanation.push(
      `Gross-up: base = net / (1 − ${rate.ratePercent.toString()}%) = ${formatAmount(base, rounding.scale)}; tax = base − net = ${formatAmount(withheld, rounding.scale)}`,
    );
  }
  const payable = base.minus(withheld);
  explanation.push(`Payee receives ${formatAmount(payable, rounding.scale)}`);

  return {
    rateCode,
    rateId: rate.id,
    ratePercent: rate.ratePercent,
    base,
    withheld,
    payable,
    rateSourceId: rate.legalSourceId,
    explanation,
  };
}
