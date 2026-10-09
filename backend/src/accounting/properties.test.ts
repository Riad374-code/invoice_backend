import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FIXTURE_RATES } from '../../tests/helpers/rates.js';
import {
  D,
  DEFAULT_ROUNDING,
  fx,
  invoice,
  journal,
  round,
  selectRate,
  taxId,
  vat,
  vatDeposit,
  type Dec,
} from './index.js';

const R = FIXTURE_RATES;
const NUM_RUNS = Number(process.env['FC_RUNS'] ?? 400);
const assertProp = (p: Parameters<typeof fc.assert>[0]) => fc.assert(p, { numRuns: NUM_RUNS });

/** İnteger qəpiklərdən "123.45" string-i (float yoxdur). */
const centsToString = (c: bigint): string => {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};
const money = (min = -100_000_000_000n, max = 100_000_000_000n) =>
  fc.bigInt({ min, max }).map(centsToString);
const positiveMoney = money(0n, 100_000_000_000n);

const VAT_CODES = ['STANDARD', 'ZERO', 'EXEMPT'] as const;
const dates = fc
  .integer({ min: 0, max: 1500 })
  .map((n) => new Date(Date.UTC(2028, 0, 1) + n * 86_400_000).toISOString().slice(0, 10));
const half = new D('0.005');

describe('property: vat', () => {
  it('gross === net + vat, VAT has ≤ 2 decimals, and |VAT − exact| ≤ half a qəpik', () => {
    assertProp(
      fc.property(money(), fc.constantFrom(...VAT_CODES), dates, (net, code, date) => {
        const r = vat.calculate(net, code, date, R);
        expect(r.net.plus(r.vat).eq(r.gross)).toBe(true);
        expect(r.vat.decimalPlaces()).toBeLessThanOrEqual(2);
        const exact = r.treatment === 'taxable' ? r.net.mul(r.ratePercent).div(100) : new D(0);
        expect(r.vat.minus(exact).abs().lte(half)).toBe(true);
        if (r.treatment !== 'taxable') expect(r.vat.isZero()).toBe(true);
      }),
    );
  });

  it('VAT is monotonic in net and sign-symmetric', () => {
    assertProp(
      fc.property(positiveMoney, positiveMoney, dates, (a, b, date) => {
        const [lo, hi] = new D(a).lte(b) ? [a, b] : [b, a];
        expect(
          vat
            .calculate(lo, 'STANDARD', date, R)
            .vat.lte(vat.calculate(hi, 'STANDARD', date, R).vat),
        ).toBe(true);
        const pos = vat.calculate(a, 'STANDARD', date, R).vat;
        const neg = vat.calculate(`-${a}`, 'STANDARD', date, R).vat;
        expect(neg.eq(pos.negated())).toBe(true); // HALF_UP sıfırdan uzağa → simmetrik
      }),
    );
  });

  it('reverse: net + vat === gross, 0 ≤ vat ≤ gross for non-negative gross', () => {
    assertProp(
      fc.property(positiveMoney, fc.constantFrom(...VAT_CODES), dates, (gross, code, date) => {
        const r = vat.reverse(gross, code, date, R);
        expect(r.net.plus(r.vat).eq(r.gross)).toBe(true);
        expect(r.vat.gte(0) && r.vat.lte(r.gross)).toBe(true);
        const exact =
          r.treatment === 'taxable'
            ? r.gross.mul(r.ratePercent).div(new D(100).plus(r.ratePercent))
            : new D(0);
        expect(r.vat.minus(exact).abs().lte(half)).toBe(true);
      }),
    );
  });

  it('calculate and reverse agree to within one qəpik', () => {
    assertProp(
      fc.property(positiveMoney, dates, (net, date) => {
        const fwd = vat.calculate(net, 'STANDARD', date, R);
        const back = vat.reverse(fwd.gross, 'STANDARD', date, R);
        expect(back.vat.minus(fwd.vat).abs().lte(new D('0.01'))).toBe(true);
        expect(back.net.minus(fwd.net).abs().lte(new D('0.01'))).toBe(true);
      }),
    );
  });

  it('the rate is always the one for the date: exactly the old rate through 2030-06-30, the new from 07-01', () => {
    assertProp(
      fc.property(dates, (date) => {
        const rate = selectRate(R, 'VAT', 'STANDARD', date);
        expect(rate.id).toBe(date <= '2030-06-30' ? 'vat-std-old' : 'vat-std-new');
      }),
    );
  });
});

describe('property: rounding', () => {
  it('is idempotent, stays within one unit of scale, and never moves a representable value', () => {
    const decStr = fc
      .tuple(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), fc.integer({ min: 0, max: 6 }))
      .map(([n, sc]) => new D(n.toString()).div(new D(10).pow(sc)));
    assertProp(
      fc.property(
        decStr,
        fc.constantFrom('HALF_UP', 'HALF_EVEN', 'UP', 'DOWN') as fc.Arbitrary<
          'HALF_UP' | 'HALF_EVEN' | 'UP' | 'DOWN'
        >,
        (x, mode) => {
          const rule = { mode, scale: 2 };
          const once: Dec = round(x, rule);
          expect(round(once, rule).eq(once)).toBe(true);
          expect(once.minus(x).abs().lt(new D('0.01'))).toBe(true);
          if (x.decimalPlaces() <= 2) expect(once.eq(x)).toBe(true);
        },
      ),
    );
  });
});

describe('property: invoice totals', () => {
  const line = fc.record({
    qty: fc.integer({ min: 1, max: 5000 }).map((n) => (n / 1000).toFixed(3)),
    unitPrice: fc.integer({ min: 1, max: 99_999_99 }).map((n) => (n / 100).toFixed(2)),
    vatRateCode: fc.constantFrom(...VAT_CODES),
  });

  it('line-level and total-level agree on every row identity; totals add up; the two levels differ by < n × qəpik', () => {
    assertProp(
      fc.property(fc.array(line, { minLength: 1, maxLength: 12 }), dates, (lines, date) => {
        const byLine = invoice.computeTotals(lines, date, R, {
          ...DEFAULT_ROUNDING,
          level: 'line',
        });
        const byTotal = invoice.computeTotals(lines, date, R, {
          ...DEFAULT_ROUNDING,
          level: 'total',
        });
        for (const t of [byLine, byTotal]) {
          expect(t.lines.reduce((a, l) => a.plus(l.vat), new D(0)).eq(t.vat)).toBe(true);
          expect(t.lines.reduce((a, l) => a.plus(l.net), new D(0)).eq(t.net)).toBe(true);
          expect(t.net.plus(t.vat).eq(t.gross)).toBe(true);
          for (const l of t.lines) expect(l.net.plus(l.vat).eq(l.gross)).toBe(true);
          const byRateVat = Object.values(t.byRate).reduce((a, b) => a.plus(b.vat), new D(0));
          expect(byRateVat.eq(t.vat)).toBe(true);
        }
        expect(byLine.net.eq(byTotal.net)).toBe(true);
        expect(byLine.vat.minus(byTotal.vat).abs().lte(half.mul(lines.length))).toBe(true);
        // total-level: cəm = bir dəfə yuvarlaqlaşdırılmış dəqiq cəm
        const exact = lines.reduce((a, _l, i) => {
          const rate = selectRate(R, 'VAT', lines[i]!.vatRateCode, date);
          return rate.ratePercent.gt(0) &&
            rate.treatment !== 'exempt' &&
            rate.treatment !== 'zero_rated'
            ? a.plus(byTotal.lines[i]!.net.mul(rate.ratePercent).div(100))
            : a;
        }, new D(0));
        expect(byTotal.vat.eq(round(exact, DEFAULT_ROUNDING))).toBe(true);
      }),
    );
  });
});

describe('property: journal', () => {
  const MAP: journal.AccountMapping = {
    receivable: '211',
    payable: '521',
    revenue: '601',
    expense: '731',
    vatOutput: '533',
    vatInput: '241',
  };
  const jline = fc.record({
    description: fc.string({ maxLength: 12 }),
    net: money(-5_000_000n, 5_000_000n),
    vat: money(-1_000_000n, 1_000_000n),
    treatment: fc.constantFrom('taxable', 'zero_rated', 'exempt') as fc.Arbitrary<
      'taxable' | 'zero_rated' | 'exempt'
    >,
    accountCode: fc.option(fc.constantFrom('601', '602', '611', '201', '731'), { nil: undefined }),
  });

  it('every proposed entry balances and validates — sales, purchases, credit notes, non-deductible VAT', () => {
    assertProp(
      fc.property(
        fc.constantFrom('sales', 'purchase') as fc.Arbitrary<'sales' | 'purchase'>,
        fc.boolean(),
        fc.array(jline, { minLength: 1, maxLength: 8 }),
        (direction, vatDeductible, lines) => {
          const total = lines.reduce((a, l) => a.plus(l.net).plus(l.vat), new D(0));
          fc.pre(!total.isZero() || lines.some((l) => !new D(l.net).isZero()));
          let entry: journal.ProposedEntry;
          try {
            entry = journal.fromInvoice(
              { direction, number: 'X', issueDate: '2030-05-01', vatDeductible, lines },
              MAP,
            );
          } catch (e) {
            // Heç nə yazılmayan hal (bütün məbləğlər sıfırdır və ya ƏDV əvəzləşdirilməyəndə net+vat=0):
            // mühərrik saxta yazılış təklif etmir, JournalError(TOO_FEW_LINES) atır
            expect(e).toBeInstanceOf(journal.JournalError);
            expect((e as journal.JournalError).issues.map((i) => i.code)).toContain(
              'TOO_FEW_LINES',
            );
            return;
          }
          const v = journal.validate(entry.lines);
          expect(v.ok).toBe(true);
          if (v.ok) {
            // sətirlərin hamısı müsbətdirsə, hər iki tərəfin cəmi = qaimənin ümumi məbləği (gross)
            if (lines.every((l) => !new D(l.net).isNegative() && !new D(l.vat).isNegative())) {
              const gross = lines.reduce((a, l) => a.plus(l.net).plus(l.vat), new D(0));
              expect(v.totalDebit.eq(gross)).toBe(true);
            }
          }
        },
      ),
    );
  });

  it('breaking a balanced entry by any non-zero amount is always detected', () => {
    assertProp(
      fc.property(
        positiveMoney,
        positiveMoney,
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        (a, b, delta) => {
          fc.pre(!new D(a).isZero() && !new D(b).isZero());
          const total = new D(a).plus(b);
          const balanced = [
            { accountCode: '211', debit: total, credit: '0' },
            { accountCode: '601', debit: '0', credit: a },
            { accountCode: '533', debit: '0', credit: b },
          ];
          expect(journal.validate(balanced).ok).toBe(true);
          const broken = [
            balanced[0]!,
            balanced[1]!,
            { ...balanced[2]!, credit: new D(b).plus(centsToString(delta)) },
          ];
          const r = journal.validate(broken);
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.issues.map((i) => i.code)).toContain('UNBALANCED');
        },
      ),
    );
  });
});

describe('property: fx', () => {
  const table = [
    { currency: 'USD', date: '2030-01-10', rate: new D('1.70'), nominal: 1, source: 'CBAR' },
    { currency: 'EUR', date: '2030-01-10', rate: new D('1.85'), nominal: 1, source: 'CBAR' },
    { currency: 'JPY', date: '2030-01-10', rate: new D('1.2345'), nominal: 100, source: 'CBAR' },
  ];
  it('round trip foreign → AZN → foreign is within a qəpik; AZN conversion is monotonic', () => {
    assertProp(
      fc.property(positiveMoney, fc.constantFrom('USD', 'EUR'), (amount, cur) => {
        const toAzn = fx.convert(amount, cur, 'AZN', '2030-01-10', table);
        const back = fx.convert(toAzn.amount, 'AZN', cur, '2030-01-10', table);
        expect(back.amount.minus(amount).abs().lte(new D('0.01'))).toBe(true);
        expect(toAzn.amount.decimalPlaces()).toBeLessThanOrEqual(2);
      }),
    );
    assertProp(
      fc.property(positiveMoney, positiveMoney, (a, b) => {
        const [lo, hi] = new D(a).lte(b) ? [a, b] : [b, a];
        expect(
          fx
            .convert(lo, 'JPY', 'AZN', '2030-01-10', table)
            .amount.lte(fx.convert(hi, 'JPY', 'AZN', '2030-01-10', table).amount),
        ).toBe(true);
      }),
    );
  });
});

describe('property: tax ids', () => {
  const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const letters = fc.string({
    unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
    minLength: 4,
    maxLength: 4,
  });
  const account = fc.string({ unit: fc.constantFrom(...alnum), minLength: 20, maxLength: 20 });

  it('every IBAN built with computed check digits validates', () => {
    assertProp(
      fc.property(letters, account, (bank, acc) => {
        const iban = taxId.buildIbanAz(bank, acc);
        expect(iban).toHaveLength(28);
        expect(taxId.validateIbanAz(iban)).toEqual({ valid: true, normalized: iban });
      }),
    );
  });

  it('changing one digit of an all-digit account always invalidates the IBAN', () => {
    const digits = fc.string({
      unit: fc.constantFrom(...'0123456789'),
      minLength: 20,
      maxLength: 20,
    });
    assertProp(
      fc.property(
        letters,
        digits,
        fc.integer({ min: 0, max: 19 }),
        fc.integer({ min: 1, max: 9 }),
        (bank, acc, pos, shift) => {
          const iban = taxId.buildIbanAz(bank, acc);
          const at = 8 + pos;
          const changed = String((Number(iban[at]) + shift) % 10);
          expect(taxId.validateIbanAz(iban.slice(0, at) + changed + iban.slice(at + 1)).valid).toBe(
            false,
          );
        },
      ),
    );
  });

  it('VÖEN: exactly the 10-digit non-zero strings', () => {
    assertProp(
      fc.property(
        fc.string({ unit: fc.constantFrom(...'0123456789'), minLength: 1, maxLength: 14 }),
        (s) => {
          const expected = s.length === 10 && !/^0+$/.test(s);
          expect(taxId.validateVoen(s).valid).toBe(expected);
        },
      ),
    );
  });
});

describe('property: vat deposit reconciliation', () => {
  const op = fc.record({
    id: fc.uuid(),
    date: dates,
    amount: money(100n, 100_000n),
    reference: fc.option(fc.constantFrom('A1', 'B2', 'C3', 'D4'), { nil: null }),
    voen: fc.option(fc.constantFrom('1111111111', '2222222222'), { nil: null }),
  });

  it('is a partition: every line is used exactly once, matches are one-to-one, and input order is irrelevant', () => {
    assertProp(
      fc.property(fc.array(op, { maxLength: 10 }), fc.array(op, { maxLength: 10 }), (s, l) => {
        const statement = s.map((x) => ({
          id: `s-${x.id}`,
          date: x.date,
          operation: 'vat_payment' as const,
          amount: x.amount,
          reference: x.reference,
          counterpartyVoen: x.voen,
        }));
        const ledger = l.map((x) => ({
          id: `l-${x.id}`,
          date: x.date,
          amount: x.amount,
          reference: x.reference,
          counterpartyVoen: x.voen,
        }));
        const m = vatDeposit.reconcile(statement, ledger);

        const stmtIds = m.flatMap((x) => (x.statementLineId ? [x.statementLineId] : []));
        const ledIds = m.flatMap((x) => (x.ledgerEntryId ? [x.ledgerEntryId] : []));
        expect(new Set(stmtIds).size).toBe(stmtIds.length);
        expect(new Set(ledIds).size).toBe(ledIds.length);
        expect([...stmtIds].sort()).toEqual(statement.map((x) => x.id).sort());
        expect([...ledIds].sort()).toEqual(ledger.map((x) => x.id).sort());

        const sum = vatDeposit.summarize(m);
        const sTotal = statement.reduce((a, x) => a.plus(x.amount), new D(0));
        const lTotal = ledger.reduce((a, x) => a.plus(x.amount), new D(0));
        expect(sum.balanceDifference.eq(sTotal.minus(lTotal))).toBe(true);

        const shuffled = vatDeposit.reconcile([...statement].reverse(), [...ledger].reverse());
        expect(shuffled.map((x) => `${x.kind}:${x.statementLineId}:${x.ledgerEntryId}`)).toEqual(
          m.map((x) => `${x.kind}:${x.statementLineId}:${x.ledgerEntryId}`),
        );
      }),
    );
  });
});
