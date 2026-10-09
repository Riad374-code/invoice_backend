import { Decimal } from 'decimal.js';
import { AccountingError } from './errors.js';

/**
 * Mühasibat hesablamaları üçün izolə olunmuş Decimal konstruktoru (qlobal Decimal.set toxunulmur).
 * 40 rəqəm dəqiqlik: AZN məbləğləri və dərəcələr üçün artıqlaması ilə kifayətdir.
 * §16: pul hesablamasında `number` istifadə olunmur — daxilolma yalnız string və ya Decimal.
 */
export const D = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});
export type Dec = InstanceType<typeof D>;

/** Qəbul olunan məbləğ girişi: `number` qəsdən YOXDUR (ikilik float səhvləri). */
export type AmountInput = string | Dec;

const AMOUNT_PATTERN = /^[+-]?\d+(\.\d+)?$/;

export function dec(value: AmountInput, label = 'amount'): Dec {
  if (typeof value === 'string') {
    const v = value.trim();
    if (!AMOUNT_PATTERN.test(v)) {
      throw new AccountingError(
        'INVALID_AMOUNT',
        `${label} "${value}" is not a plain decimal number`,
      );
    }
    return new D(v);
  }
  if (D.isDecimal(value)) return new D(value);
  throw new AccountingError('INVALID_AMOUNT', `${label} must be a string or Decimal`);
}

export const ZERO: Dec = new D(0);
export const HUNDRED: Dec = new D(100);

/** API-yə çıxış: həmişə sabit onluq rəqəmli string (məs. "118.00"). */
export function formatAmount(value: Dec, scale = 2): string {
  return value.toFixed(scale, Decimal.ROUND_HALF_UP);
}

export function sum(values: readonly Dec[]): Dec {
  return values.reduce<Dec>((acc, v) => acc.plus(v), ZERO);
}

export interface Money {
  amount: Dec;
  currency: string;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
export function assertCurrency(code: string): string {
  if (!CURRENCY_PATTERN.test(code)) {
    throw new AccountingError(
      'INVALID_CURRENCY',
      `Currency "${code}" must be a 3-letter ISO 4217 code`,
    );
  }
  return code;
}
