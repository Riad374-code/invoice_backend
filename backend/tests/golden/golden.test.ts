import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  D,
  type Dec,
  invoice,
  journal,
  taxRate,
  vat,
  formatAmount,
  type RoundingRule,
  type TaxRate,
} from '../../src/accounting/index.js';
import { buildGolden } from './generate.js';

const dir = fileURLToPath(new URL('.', import.meta.url));
const load = <T>(name: string): T => JSON.parse(readFileSync(`${dir}${name}`, 'utf8')) as T;

interface RateRow {
  id: string;
  taxType: 'VAT';
  code: string;
  ratePercent: string;
  validFrom: string;
  validTo: string | null;
  legalSourceId: string | null;
  status: 'active' | 'proposed';
  treatment: 'taxable' | 'zero_rated' | 'exempt' | null;
}
const rates: TaxRate[] = load<{ rates: RateRow[] }>('rates.json').rates.map((r) => taxRate(r));

const rule = (r: {
  mode: RoundingRule['mode'];
  scale: number;
  level: RoundingRule['level'];
}): RoundingRule => r;

function expectNoMismatches(mismatches: string[], total: number) {
  expect(total).toBeGreaterThan(100);
  expect(mismatches.slice(0, 10), `${mismatches.length}/${total} golden cases differ`).toEqual([]);
}

describe('golden files are generated from the independent BigInt reference and are in sync', () => {
  it('committed files equal a fresh deterministic generation', () => {
    for (const [name, content] of Object.entries(buildGolden())) {
      expect(load(name), name).toEqual(JSON.parse(JSON.stringify(content)));
    }
  });
});

describe('golden: vat.calculate', () => {
  const { cases } = load<{
    cases: Array<{
      id: string;
      input: { net: string; rateCode: string; date: string; rounding: RoundingRule };
      expected: { rateId: string; treatment: string; net: string; vat: string; gross: string };
    }>;
  }>('vat-calculate.json');

  it(`all ${cases.length} cases match`, () => {
    const bad: string[] = [];
    for (const c of cases) {
      const r = vat.calculate(
        c.input.net,
        c.input.rateCode,
        c.input.date,
        rates,
        rule(c.input.rounding),
      );
      const got = {
        rateId: r.rateId,
        treatment: r.treatment,
        net: formatAmount(r.net),
        vat: formatAmount(r.vat),
        gross: formatAmount(r.gross),
      };
      if (JSON.stringify(got) !== JSON.stringify(c.expected)) {
        bad.push(
          `${c.id} ${JSON.stringify(c.input)} → got ${JSON.stringify(got)}, want ${JSON.stringify(c.expected)}`,
        );
      }
    }
    expectNoMismatches(bad, cases.length);
  });

  it('covers every rounding mode, every rate code and both sides of the rate change', () => {
    expect(new Set(cases.map((c) => c.input.rounding.mode))).toEqual(
      new Set(['HALF_UP', 'HALF_EVEN', 'UP', 'DOWN']),
    );
    expect(new Set(cases.map((c) => c.input.rateCode))).toEqual(
      new Set(['STANDARD', 'REDUCED', 'ZERO', 'EXEMPT']),
    );
    const ids = new Set(cases.map((c) => c.expected.rateId));
    expect(ids.has('vat-std-old') && ids.has('vat-std-new')).toBe(true);
    for (const d of ['2030-06-29', '2030-06-30', '2030-07-01', '2030-07-02']) {
      expect(
        cases.some((c) => c.input.date === d),
        d,
      ).toBe(true);
    }
  });
});

describe('golden: vat.reverse', () => {
  const { cases } = load<{
    cases: Array<{
      id: string;
      input: { gross: string; rateCode: string; date: string; rounding: RoundingRule };
      expected: { rateId: string; treatment: string; gross: string; vat: string; net: string };
    }>;
  }>('vat-reverse.json');

  it(`all ${cases.length} cases match, and net + vat always equals gross`, () => {
    const bad: string[] = [];
    for (const c of cases) {
      const r = vat.reverse(
        c.input.gross,
        c.input.rateCode,
        c.input.date,
        rates,
        rule(c.input.rounding),
      );
      const got = {
        rateId: r.rateId,
        treatment: r.treatment,
        gross: formatAmount(r.gross),
        vat: formatAmount(r.vat),
        net: formatAmount(r.net),
      };
      if (JSON.stringify(got) !== JSON.stringify(c.expected)) {
        bad.push(
          `${c.id} ${JSON.stringify(c.input)} → got ${JSON.stringify(got)}, want ${JSON.stringify(c.expected)}`,
        );
      }
      if (!r.net.plus(r.vat).eq(r.gross)) bad.push(`${c.id}: net + vat ≠ gross`);
    }
    expectNoMismatches(bad, cases.length);
  });
});

describe('golden: invoices — totals and proposed journal entries', () => {
  const { cases, mapping } = load<{
    mapping: journal.AccountMapping;
    cases: Array<{
      id: string;
      direction: 'sales' | 'purchase';
      number: string;
      issueDate: string;
      rounding: RoundingRule;
      lines: Array<{ description: string; qty: string; unitPrice: string; vatRateCode: string }>;
      expected: {
        lineNets: string[];
        lineVats?: string[];
        net: string;
        vat: string;
        gross: string;
        byRate: Record<string, { net: string; vat?: string }>;
        journalTotals: Record<string, { debit: string; credit: string }>;
      };
    }>;
  }>('invoices.json');

  it(`all ${cases.length} invoices: line nets, VAT, gross and rate buckets match`, () => {
    const bad: string[] = [];
    for (const c of cases) {
      const t = invoice.computeTotals(c.lines, c.issueDate, rates, rule(c.rounding));
      const fail = (what: string, got: unknown, want: unknown) =>
        bad.push(`${c.id} ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

      if (
        JSON.stringify(t.lines.map((l) => formatAmount(l.net))) !==
        JSON.stringify(c.expected.lineNets)
      )
        fail(
          'lineNets',
          t.lines.map((l) => formatAmount(l.net)),
          c.expected.lineNets,
        );
      if (
        c.expected.lineVats &&
        JSON.stringify(t.lines.map((l) => formatAmount(l.vat))) !==
          JSON.stringify(c.expected.lineVats)
      ) {
        fail(
          'lineVats',
          t.lines.map((l) => formatAmount(l.vat)),
          c.expected.lineVats,
        );
      }
      for (const [k, want, got] of [
        ['net', c.expected.net, formatAmount(t.net)],
        ['vat', c.expected.vat, formatAmount(t.vat)],
        ['gross', c.expected.gross, formatAmount(t.gross)],
      ] as const) {
        if (want !== got) fail(k, got, want);
      }
      // cəm səviyyəsində: sətir ƏDV-ləri cəmə dəqiq bərabər olmalıdır (bölgü)
      const sumLineVat = t.lines.reduce((a, l) => a.plus(l.vat), new D(0));
      if (!sumLineVat.eq(t.vat))
        fail('sum(line vat) = vat', formatAmount(sumLineVat), formatAmount(t.vat));
      for (const [code, want] of Object.entries(c.expected.byRate)) {
        const got = t.byRate[code];
        if (!got || formatAmount(got.net) !== want.net)
          fail(`byRate.${code}.net`, got && formatAmount(got.net), want.net);
        if (want.vat !== undefined && (!got || formatAmount(got.vat) !== want.vat))
          fail(`byRate.${code}.vat`, got && formatAmount(got.vat), want.vat);
      }
      if (Object.keys(t.byRate).length !== Object.keys(c.expected.byRate).length)
        fail('byRate keys', Object.keys(t.byRate), Object.keys(c.expected.byRate));

      // jurnal
      const entry = journal.fromInvoice(
        {
          direction: c.direction,
          number: c.number,
          issueDate: c.issueDate,
          lines: t.lines.map((l, i) => ({
            description: c.lines[i]!.description,
            net: l.net,
            vat: l.vat,
            treatment: l.treatment,
          })),
        },
        mapping,
      );
      const v = journal.validate(entry.lines);
      if (!v.ok) fail('journal valid', v.issues, 'ok');
      const agg: Record<string, { debit: Dec; credit: Dec }> = {};
      for (const l of entry.lines) {
        const a = (agg[l.accountCode] ??= { debit: new D(0), credit: new D(0) });
        a.debit = a.debit.plus(l.debit);
        a.credit = a.credit.plus(l.credit);
      }
      const gotAgg = Object.fromEntries(
        Object.entries(agg).map(([k, a]) => [
          k,
          { debit: formatAmount(a.debit), credit: formatAmount(a.credit) },
        ]),
      );
      if (JSON.stringify(sortKeys(gotAgg)) !== JSON.stringify(sortKeys(c.expected.journalTotals))) {
        fail('journal totals', gotAgg, c.expected.journalTotals);
      }
    }
    expectNoMismatches(bad, cases.length);
  });

  it('exercises both rounding levels and both directions', () => {
    expect(new Set(cases.map((c) => c.rounding.level))).toEqual(new Set(['line', 'total']));
    expect(new Set(cases.map((c) => c.direction))).toEqual(new Set(['sales', 'purchase']));
  });
});

describe('golden: invoice.check', () => {
  const { cases } = load<{
    cases: Array<{
      id: string;
      defect: string;
      invoice: invoice.InvoiceInput;
      existing: invoice.ExistingInvoiceRef[];
      expectedIssueCodes: string[];
    }>;
  }>('invoice-check.json');

  it(`all ${cases.length} invoices raise exactly the injected issues`, () => {
    const bad: string[] = [];
    for (const c of cases) {
      const issues = invoice.check(c.invoice, { rates, existing: c.existing });
      const got = issues.map((i) => i.code).sort();
      if (JSON.stringify(got) !== JSON.stringify(c.expectedIssueCodes)) {
        bad.push(
          `${c.id} [${c.defect}] got ${JSON.stringify(got)}, want ${JSON.stringify(c.expectedIssueCodes)} — ${issues.map((i) => i.message).join(' | ')}`,
        );
      }
    }
    expectNoMismatches(bad, cases.length);
  });

  it('covers every defect kind', () => {
    const kinds = new Set(cases.map((c) => c.defect));
    for (const k of [
      'none',
      'vat_tamper',
      'wrong_rate',
      'header_gross',
      'header_net',
      'qty_price',
      'bad_voen',
      'unknown_rate',
      'duplicate',
      'bad_date',
    ]) {
      expect(kinds.has(k), k).toBe(true);
    }
  });
});

function sortKeys<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))) as T;
}
