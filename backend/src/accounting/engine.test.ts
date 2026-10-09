import { describe, expect, it } from 'vitest';
import { FIXTURE_RATES } from '../../tests/helpers/rates.js';
import {
  AccountingError,
  D,
  DEFAULT_ROUNDING,
  addDays,
  assertLocalDate,
  daysBetween,
  dec,
  formatAmount,
  fx,
  isLocalDate,
  round,
  roundingFor,
  selectRate,
  taxRate,
  vat,
  vatTreatmentOf,
  withholding,
} from './index.js';

const f = (v: { toString(): string }) => v.toString();
const R = FIXTURE_RATES;

describe('money / dec', () => {
  it('accepts plain decimal strings only — never floats', () => {
    expect(f(dec('12.50'))).toBe('12.5');
    expect(f(dec(' -0.01 '))).toBe('-0.01');
    for (const bad of ['', '1,5', '1e3', 'abc', '1.', '.5', '0x10', '1 000', 'NaN', 'Infinity']) {
      expect(() => dec(bad), bad).toThrow(AccountingError);
    }
    expect(() => dec(1.1 as unknown as string)).toThrow(AccountingError);
  });
  it('0.1 + 0.2 is exactly 0.3 (the float trap)', () => {
    expect(f(dec('0.1').plus(dec('0.2')))).toBe('0.3');
  });
  it('formatAmount always yields fixed decimals', () => {
    expect(formatAmount(dec('118'))).toBe('118.00');
    expect(formatAmount(dec('0.125'))).toBe('0.13');
    expect(formatAmount(dec('1234567.891'), 2)).toBe('1234567.89');
  });
});

describe('rounding', () => {
  const r = (v: string, mode: 'HALF_UP' | 'HALF_EVEN' | 'UP' | 'DOWN') =>
    f(round(dec(v), { mode, scale: 2 }));
  it('HALF_UP rounds ties away from zero (symmetric for credit notes)', () => {
    expect(r('0.125', 'HALF_UP')).toBe('0.13');
    expect(r('-0.125', 'HALF_UP')).toBe('-0.13');
    expect(r('0.124', 'HALF_UP')).toBe('0.12');
    expect(r('2.675', 'HALF_UP')).toBe('2.68'); // float 2.675 → 2.67 olardı
  });
  it('HALF_EVEN, UP and DOWN', () => {
    expect(r('0.125', 'HALF_EVEN')).toBe('0.12');
    expect(r('0.135', 'HALF_EVEN')).toBe('0.14');
    expect(r('0.121', 'UP')).toBe('0.13');
    expect(r('0.129', 'DOWN')).toBe('0.12');
    expect(r('-0.121', 'UP')).toBe('-0.13');
  });
  it('is idempotent and jurisdiction-configurable', () => {
    const once = round(dec('10.005'), DEFAULT_ROUNDING);
    expect(round(once, DEFAULT_ROUNDING).eq(once)).toBe(true);
    expect(roundingFor('AZ')).toEqual({ mode: 'HALF_UP', scale: 2, level: 'line' });
    expect(roundingFor('XX')).toEqual(DEFAULT_ROUNDING);
  });
});

describe('dates', () => {
  it('validates real calendar days', () => {
    expect(isLocalDate('2030-02-28')).toBe(true);
    expect(isLocalDate('2032-02-29')).toBe(true);
    expect(isLocalDate('2030-02-29')).toBe(false);
    expect(isLocalDate('2030-13-01')).toBe(false);
    expect(isLocalDate('2030-1-1')).toBe(false);
    expect(isLocalDate('01.01.2030')).toBe(false);
    expect(() => assertLocalDate('nope')).toThrow(AccountingError);
  });
  it('adds days across month/year/leap boundaries and diffs them', () => {
    expect(addDays('2030-12-31', 1)).toBe('2031-01-01');
    expect(addDays('2032-02-28', 1)).toBe('2032-02-29');
    expect(addDays('2030-03-01', -1)).toBe('2030-02-28');
    expect(daysBetween('2030-01-01', '2030-01-31')).toBe(30);
    expect(daysBetween('2030-02-01', '2030-01-01')).toBe(-31);
  });
});

describe('rates.selectRate — rate comes from the table, by operation date', () => {
  it('picks the rate in force, with inclusive boundaries (one day before / on / after the change)', () => {
    expect(selectRate(R, 'VAT', 'STANDARD', '2030-06-29').id).toBe('vat-std-old');
    expect(selectRate(R, 'VAT', 'STANDARD', '2030-06-30').id).toBe('vat-std-old'); // validTo daxil
    expect(selectRate(R, 'VAT', 'STANDARD', '2030-07-01').id).toBe('vat-std-new'); // validFrom daxil
    expect(selectRate(R, 'VAT', 'STANDARD', '2030-07-02').id).toBe('vat-std-new');
  });
  it('never uses proposed rates', () => {
    expect(() => selectRate(R, 'VAT', 'PROPOSED_ONLY', '2030-01-01')).toThrowError(
      expect.objectContaining({ code: 'RATE_NOT_FOUND' }),
    );
  });
  it('fails loudly: unknown code, before first validity, wrong tax type, bad date', () => {
    expect(() => selectRate(R, 'VAT', 'NOPE', '2030-01-01')).toThrowError(
      expect.objectContaining({ code: 'RATE_NOT_FOUND' }),
    );
    expect(() => selectRate(R, 'VAT', 'STANDARD', '2000-12-31')).toThrowError(
      expect.objectContaining({ code: 'RATE_NOT_FOUND' }),
    );
    expect(() => selectRate(R, 'PROFIT', 'STANDARD', '2030-01-01')).toThrow(AccountingError);
    expect(() => selectRate(R, 'VAT', 'STANDARD', '30/06/2030')).toThrowError(
      expect.objectContaining({ code: 'INVALID_DATE' }),
    );
  });
  it('detects overlapping active rates instead of guessing', () => {
    const overlapping = [
      ...R,
      taxRate({
        id: 'dup',
        taxType: 'VAT',
        code: 'STANDARD',
        ratePercent: '19',
        validFrom: '2030-06-01',
        validTo: '2030-12-31',
      }),
    ];
    expect(() => selectRate(overlapping, 'VAT', 'STANDARD', '2030-06-15')).toThrowError(
      expect.objectContaining({ code: 'RATE_AMBIGUOUS' }),
    );
    expect(selectRate(overlapping, 'VAT', 'STANDARD', '2030-05-15').id).toBe('vat-std-old');
  });
  it('derives treatment: explicit wins, otherwise 0% = zero_rated', () => {
    expect(vatTreatmentOf(selectRate(R, 'VAT', 'STANDARD', '2030-01-01'))).toBe('taxable');
    expect(vatTreatmentOf(selectRate(R, 'VAT', 'ZERO', '2030-01-01'))).toBe('zero_rated');
    expect(vatTreatmentOf(selectRate(R, 'VAT', 'EXEMPT', '2030-01-01'))).toBe('exempt');
    const implicitZero = taxRate({
      id: 'z',
      taxType: 'VAT',
      code: 'Z',
      ratePercent: '0',
      validFrom: '2001-01-01',
    });
    expect(vatTreatmentOf(implicitZero)).toBe('zero_rated');
  });
});

describe('vat.calculate (hand-computed)', () => {
  const calc = (net: string, code = 'STANDARD', date = '2030-05-01', rounding = DEFAULT_ROUNDING) =>
    vat.calculate(net, code, date, R, rounding);
  const out = (r: ReturnType<typeof calc>) => [
    f(r.net),
    formatAmount(r.vat),
    formatAmount(r.gross),
  ];

  it.each([
    ['100.00', ['100', '18.00', '118.00']],
    ['0.00', ['0', '0.00', '0.00']],
    ['0.25', ['0.25', '0.05', '0.30']], // 0.045 → 0.05
    ['33.33', ['33.33', '6.00', '39.33']], // 5.9994
    ['1000000.00', ['1000000', '180000.00', '1180000.00']],
    ['0.01', ['0.01', '0.00', '0.01']], // 0.0018
    ['0.03', ['0.03', '0.01', '0.04']], // 0.0054
    ['-0.25', ['-0.25', '-0.05', '-0.30']], // kredit-nota, simmetrik
    ['99999999.99', ['99999999.99', '18000000.00', '117999999.99']], // 17999999.9982
  ])('net %s @18%% → %j', (net, expected) => {
    expect(out(calc(net))).toEqual(expected);
  });

  it('uses the rate in force on the operation date (not today)', () => {
    expect(out(calc('100.00', 'STANDARD', '2030-06-30'))).toEqual(['100', '18.00', '118.00']);
    expect(out(calc('100.00', 'STANDARD', '2030-07-01'))).toEqual(['100', '20.00', '120.00']);
    expect(calc('100', 'STANDARD', '2030-06-30').rateId).toBe('vat-std-old');
    expect(calc('100', 'STANDARD', '2030-07-01').rateId).toBe('vat-std-new');
  });

  it('zero-rated and exempt supplies carry no VAT but keep their distinct treatment', () => {
    const z = calc('500.00', 'ZERO');
    const e = calc('500.00', 'EXEMPT');
    expect(out(z)).toEqual(['500', '0.00', '500.00']);
    expect(out(e)).toEqual(['500', '0.00', '500.00']);
    expect([z.treatment, e.treatment]).toEqual(['zero_rated', 'exempt']);
  });

  it('honours the configured rounding mode', () => {
    const rule = (mode: 'HALF_UP' | 'HALF_EVEN' | 'UP' | 'DOWN') => ({ ...DEFAULT_ROUNDING, mode });
    expect(formatAmount(calc('0.25', 'STANDARD', '2030-05-01', rule('HALF_UP')).vat)).toBe('0.05'); // 0.045
    expect(formatAmount(calc('0.25', 'STANDARD', '2030-05-01', rule('HALF_EVEN')).vat)).toBe(
      '0.04',
    );
    expect(formatAmount(calc('0.30', 'STANDARD', '2030-05-01', rule('DOWN')).vat)).toBe('0.05'); // 0.054
    expect(formatAmount(calc('0.30', 'STANDARD', '2030-05-01', rule('UP')).vat)).toBe('0.06');
  });

  it('rounds an over-precise net first and says so', () => {
    const r = calc('10.005');
    expect(f(r.net)).toBe('10.01');
    expect(r.explanation.join('\n')).toMatch(/rounded to 10\.01/);
  });

  it('explains the rate, its legal source and the arithmetic (§6.1)', () => {
    const r = calc('100.00');
    expect(r.rateSourceId).toBe('src-tax-code');
    const text = r.explanation.join('\n');
    expect(text).toContain('Rate "STANDARD" = 18% (taxable)');
    expect(text).toContain('id vat-std-old');
    expect(text).toContain('legal source src-tax-code');
    expect(text).toContain('VAT = net × 18%');
    expect(text).toContain('Gross = net + VAT = 118.00');
  });

  it('rejects garbage input and missing rates', () => {
    expect(() => calc('abc')).toThrowError(expect.objectContaining({ code: 'INVALID_AMOUNT' }));
    expect(() => calc('100', 'NOPE')).toThrowError(
      expect.objectContaining({ code: 'RATE_NOT_FOUND' }),
    );
    expect(() => calc('100', 'STANDARD', '2030-02-30')).toThrowError(
      expect.objectContaining({ code: 'INVALID_DATE' }),
    );
  });
});

describe('vat.reverse (hand-computed)', () => {
  const rev = (gross: string, code = 'STANDARD', date = '2030-05-01') =>
    vat.reverse(gross, code, date, R);
  const out = (r: ReturnType<typeof rev>) => [
    formatAmount(r.net),
    formatAmount(r.vat),
    formatAmount(r.gross),
  ];

  it.each([
    ['118.00', ['100.00', '18.00', '118.00']],
    ['100.00', ['84.75', '15.25', '100.00']], // 15.2542
    ['0.01', ['0.01', '0.00', '0.01']],
    ['1.18', ['1.00', '0.18', '1.18']],
    ['0.00', ['0.00', '0.00', '0.00']],
  ])('gross %s @18%% → %j', (gross, expected) => {
    expect(out(rev(gross))).toEqual(expected);
  });

  it('uses the new rate after the change date', () => {
    expect(out(rev('120.00', 'STANDARD', '2030-07-01'))).toEqual(['100.00', '20.00', '120.00']);
  });
  it('exempt / zero-rated: net = gross', () => {
    expect(out(rev('250.00', 'EXEMPT'))).toEqual(['250.00', '0.00', '250.00']);
    expect(out(rev('250.00', 'ZERO'))).toEqual(['250.00', '0.00', '250.00']);
  });
  it('net + vat === gross exactly, even where rounding bites', () => {
    for (const g of ['0.07', '19.99', '123456.78', '99.99', '0.55']) {
      const r = rev(g);
      expect(r.net.plus(r.vat).eq(dec(g))).toBe(true);
    }
  });
});

describe('withholding.calculate (hand-computed)', () => {
  const wh = (
    amount: string,
    code = 'WHT_10',
    basis: 'gross_payment' | 'net_payment' = 'gross_payment',
  ) => withholding.calculate(amount, code, '2030-05-01', R, DEFAULT_ROUNDING, basis);
  const out = (r: ReturnType<typeof wh>) => [
    formatAmount(r.base),
    formatAmount(r.withheld),
    formatAmount(r.payable),
  ];

  it('deducts the tax from a gross payment', () => {
    expect(out(wh('1000.00'))).toEqual(['1000.00', '100.00', '900.00']);
    expect(out(wh('100.01'))).toEqual(['100.01', '10.00', '90.01']); // 10.001
    expect(out(wh('1000.00', 'WHT_4_5'))).toEqual(['1000.00', '45.00', '955.00']);
    expect(out(wh('0.05'))).toEqual(['0.05', '0.01', '0.04']); // 0.005 → 0.01
  });
  it('grosses up when the payer bears the tax (payee must net the agreed amount)', () => {
    expect(out(wh('900.00', 'WHT_10', 'net_payment'))).toEqual(['1000.00', '100.00', '900.00']);
    const odd = wh('100.01', 'WHT_10', 'net_payment');
    expect(out(odd)).toEqual(['111.12', '11.11', '100.01']); // 111.1222
    expect(odd.payable.eq(dec('100.01'))).toBe(true);
  });
  it('explains and cites the rate source', () => {
    const r = wh('1000.00');
    expect(r.rateSourceId).toBe('src-wht');
    expect(r.explanation.join('\n')).toContain('Withholding rate "WHT_10" = 10%');
  });
  it('rejects unknown codes and rates of 100% or more', () => {
    expect(() => wh('100', 'NOPE')).toThrowError(
      expect.objectContaining({ code: 'RATE_NOT_FOUND' }),
    );
    const rates = [
      taxRate({
        id: 'x',
        taxType: 'WITHHOLDING',
        code: 'ALL',
        ratePercent: '100',
        validFrom: '2001-01-01',
      }),
    ];
    expect(() => withholding.calculate('100', 'ALL', '2030-01-01', rates)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RATE' }),
    );
  });
});

describe('fx.convert (CBAR-style table)', () => {
  const t = (currency: string, date: string, rate: string, nominal = 1) => ({
    currency,
    date,
    rate: new D(rate),
    nominal,
    source: 'CBAR',
  });
  const table = [
    t('USD', '2030-01-10', '1.70'),
    t('EUR', '2030-01-10', '1.85'),
    t('JPY', '2030-01-10', '1.2345', 100),
    t('USD', '2030-01-05', '1.69'),
  ];
  const conv = (amount: string, from: string, to: string, date = '2030-01-10') =>
    fx.convert(amount, from, to, date, table);

  it('converts to and from AZN at the published rate', () => {
    expect(formatAmount(conv('100', 'USD', 'AZN').amount)).toBe('170.00');
    expect(formatAmount(conv('170', 'AZN', 'USD').amount)).toBe('100.00');
  });
  it('cross-converts through AZN without rounding the intermediate', () => {
    // 100 USD = 170 AZN = 91.891891… EUR
    expect(formatAmount(conv('100', 'USD', 'EUR').amount)).toBe('91.89');
  });
  it('respects the rate nominal (JPY is quoted per 100)', () => {
    expect(formatAmount(conv('1000', 'JPY', 'AZN').amount)).toBe('12.35'); // 12.345
  });
  it('is the identity for the same currency', () => {
    expect(formatAmount(conv('12.34', 'USD', 'USD').amount)).toBe('12.34');
  });
  it('uses the latest earlier rate on weekends/holidays, within the staleness window', () => {
    const r = conv('100', 'USD', 'AZN', '2030-01-12');
    expect(formatAmount(r.amount)).toBe('170.00');
    expect(r.ratesUsed[0]?.date).toBe('2030-01-10');
    expect(r.explanation.join('\n')).toContain('2 day(s) before 2030-01-12');
    // 2030-01-06 → 2030-01-05 kursu (1 gün əvvəl), yeni kurs deyil
    expect(formatAmount(conv('100', 'USD', 'AZN', '2030-01-06').amount)).toBe('169.00');
  });
  it('never uses a future rate and never reaches back further than allowed', () => {
    expect(() => conv('100', 'USD', 'AZN', '2030-01-04')).toThrowError(
      expect.objectContaining({ code: 'FX_RATE_NOT_FOUND' }),
    );
    expect(() => conv('100', 'USD', 'AZN', '2030-02-01')).toThrowError(
      expect.objectContaining({ code: 'FX_RATE_NOT_FOUND' }),
    );
    expect(() => conv('100', 'GBP', 'AZN')).toThrowError(
      expect.objectContaining({ code: 'FX_RATE_NOT_FOUND' }),
    );
  });
  it('flags conflicting same-day rates and invalid currency codes', () => {
    const dup = [...table, t('USD', '2030-01-10', '1.71')];
    expect(() => fx.convert('1', 'USD', 'AZN', '2030-01-10', dup)).toThrowError(
      expect.objectContaining({ code: 'RATE_AMBIGUOUS' }),
    );
    expect(() => conv('1', 'usd', 'AZN')).toThrowError(
      expect.objectContaining({ code: 'INVALID_CURRENCY' }),
    );
  });
});

describe('remaining edge branches', () => {
  it('selectRate rejects a stored rate outside 0..100%', () => {
    const broken = [
      taxRate({ id: 'b', taxType: 'VAT', code: 'B', ratePercent: '150', validFrom: '2001-01-01' }),
    ];
    expect(() => selectRate(broken, 'VAT', 'B', '2030-01-01')).toThrowError(
      expect.objectContaining({ code: 'INVALID_RATE' }),
    );
  });
  it('fx rejects non-positive rates and invalid nominals', () => {
    const t = (rate: string, nominal: number) => [
      { currency: 'USD', date: '2030-01-10', rate: new D(rate), nominal, source: 'CBAR' },
    ];
    expect(() => fx.convert('1', 'USD', 'AZN', '2030-01-10', t('0', 1))).toThrowError(
      expect.objectContaining({ code: 'INVALID_RATE' }),
    );
    expect(() => fx.convert('1', 'USD', 'AZN', '2030-01-10', t('-1', 1))).toThrowError(
      expect.objectContaining({ code: 'INVALID_RATE' }),
    );
    expect(() => fx.convert('1', 'USD', 'AZN', '2030-01-10', t('1.7', 0))).toThrowError(
      expect.objectContaining({ code: 'INVALID_RATE' }),
    );
    expect(() => fx.convert('1', 'USD', 'AZN', '2030-01-10', t('1.7', 1.5))).toThrowError(
      expect.objectContaining({ code: 'INVALID_RATE' }),
    );
  });
  it('vat.reverse explains rounding of an over-precise gross; withholding explains an open-ended rate', () => {
    const r = vat.reverse('118.005', 'STANDARD', '2030-05-01', R);
    expect(f(r.gross)).toBe('118.01');
    expect(r.explanation.join('\n')).toMatch(/Gross 118\.005 rounded to 118\.01/);
    const w = withholding.calculate('100', 'WHT_10', '2030-05-01', R);
    expect(w.explanation[0]).toContain('..open');
    const bounded = [
      taxRate({
        id: 'wb',
        taxType: 'WITHHOLDING',
        code: 'WB',
        ratePercent: '5',
        validFrom: '2001-01-01',
        validTo: '2030-12-31',
      }),
    ];
    expect(withholding.calculate('100', 'WB', '2030-05-01', bounded).explanation[0]).toContain(
      '2001-01-01..2030-12-31',
    );
  });
});
