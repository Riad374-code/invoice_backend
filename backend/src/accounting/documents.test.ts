import { describe, expect, it } from 'vitest';
import { FIXTURE_RATES } from '../../tests/helpers/rates.js';
import {
  DEFAULT_ROUNDING,
  formatAmount,
  invoice,
  journal,
  payroll,
  taxRate,
  taxId,
  vatDeposit,
  type AmountInput,
} from './index.js';

const R = FIXTURE_RATES;
const S = (v: { toString(): string } | null) => (v === null ? null : formatAmount(v as never));

describe('taxId.validateVoen', () => {
  it('accepts exactly 10 digits (ignoring whitespace)', () => {
    expect(taxId.validateVoen('1234567891')).toEqual({ valid: true, normalized: '1234567891' });
    expect(taxId.validateVoen(' 1234 5678 91 ')).toEqual({ valid: true, normalized: '1234567891' });
  });
  it.each(['', '123456789', '12345678901', '12345678a1', '0000000000', '12.3456789'])(
    'rejects %j',
    (v) => {
      expect(taxId.validateVoen(v).valid).toBe(false);
    },
  );
});

describe('taxId.validateFin', () => {
  it('accepts 7 letters/digits, normalising case', () => {
    expect(taxId.validateFin('5abc12d')).toEqual({ valid: true, normalized: '5ABC12D' });
    expect(taxId.validateFin('1234567').valid).toBe(true);
  });
  it.each(['', 'ABC123', 'ABC12345', 'ABC-123', 'ƏBC1234'])('rejects %j', (v) => {
    expect(taxId.validateFin(v).valid).toBe(false);
  });
});

describe('taxId.validateIbanAz', () => {
  it('builds check digits that match the published registry example', () => {
    expect(taxId.buildIbanAz('NABZ', '00000000137010001944')).toBe('AZ21NABZ00000000137010001944');
    expect(taxId.validateIbanAz('AZ21NABZ00000000137010001944')).toEqual({
      valid: true,
      normalized: 'AZ21NABZ00000000137010001944',
    });
  });
  it('tolerates spaces and lower case', () => {
    expect(taxId.validateIbanAz('az21 nabz 0000 0000 1370 1000 1944').valid).toBe(true);
  });
  it('rejects wrong check digits, length, country and charset', () => {
    expect(taxId.validateIbanAz('AZ22NABZ00000000137010001944')).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/check digits/),
    });
    expect(taxId.validateIbanAz('AZ21NABZ0000000013701000194')).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/28/),
    });
    expect(taxId.validateIbanAz('GB82WEST12345698765432')).toMatchObject({ valid: false });
    expect(taxId.validateIbanAz('AZ21NABZ0000000013701000194!')).toMatchObject({ valid: false });
    expect(taxId.validateIbanAz('AZ2ENABZ00000000137010001944').valid).toBe(false);
  });
  it('a single changed digit always breaks the checksum (mod 97-10 guarantee)', () => {
    const good = taxId.buildIbanAz('AIIB', '12345678901234567890');
    expect(taxId.validateIbanAz(good).valid).toBe(true);
    for (let i = 4; i < good.length; i++) {
      const ch = good[i]!;
      const swap = ch === '1' ? '2' : '1';
      expect(
        taxId.validateIbanAz(good.slice(0, i) + swap + good.slice(i + 1)).valid,
        `pos ${i}`,
      ).toBe(false);
    }
  });
});

// ------------------------------------------------------------------- journal
const MAP: journal.AccountMapping = {
  receivable: '211',
  payable: '521',
  revenue: '601',
  expense: '731',
  vatOutput: '533',
  vatInput: '241',
};
const L = (accountCode: string, debit: AmountInput, credit: AmountInput) => ({
  accountCode,
  debit,
  credit,
});

describe('journal.validate', () => {
  it('accepts a balanced entry', () => {
    const r = journal.validate([
      L('211', '118.00', '0'),
      L('601', '0', '100.00'),
      L('533', '0', '18.00'),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect([S(r.totalDebit), S(r.totalCredit)]).toEqual(['118.00', '118.00']);
  });
  it('reports every problem at once', () => {
    const r = journal.validate([
      L('21', '10', '0'),
      L('601', '5', '5'),
      L('XYZ', '-1', '0'),
      L('601', '0.001', '0'),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.issues.map((i) => i.code);
      expect(codes).toEqual(
        expect.arrayContaining([
          'INVALID_ACCOUNT_CODE',
          'BOTH_SIDES',
          'NEGATIVE_AMOUNT',
          'EXCESS_PRECISION',
          'UNBALANCED',
        ]),
      );
    }
  });
  it('rejects unbalanced, one-line, zero-line and non-numeric entries', () => {
    expect(journal.validate([L('211', '100', '0'), L('601', '0', '99.99')])).toMatchObject({
      ok: false,
      issues: [{ code: 'UNBALANCED' }],
    });
    expect(journal.validate([L('211', '0', '0')])).toMatchObject({ ok: false });
    const zero = journal.validate([L('211', '0', '0'), L('601', '0', '0')]);
    expect(zero.ok === false && zero.issues.map((i) => i.code)).toContain('ZERO_LINE');
    const bad = journal.validate([L('211', 'abc', '0'), L('601', '0', '1')]);
    expect(bad.ok === false && bad.issues.map((i) => i.code)).toContain('INVALID_AMOUNT');
  });
  it('checks accounts against the chart when one is supplied', () => {
    const lines = [L('211', '10', '0'), L('999', '0', '10')];
    expect(journal.validate(lines).ok).toBe(true);
    const r = journal.validate(lines, { chart: ['211', '601'] });
    expect(r.ok === false && r.issues).toEqual([
      expect.objectContaining({ code: 'UNKNOWN_ACCOUNT', lineIndex: 1 }),
    ]);
  });
  it('assertValid throws a JournalError carrying the issues', () => {
    expect(() => journal.assertValid([L('211', '1', '0'), L('601', '0', '2')])).toThrowError(
      journal.JournalError,
    );
  });
});

describe('journal.fromInvoice', () => {
  const totals = (entry: journal.ProposedEntry) =>
    Object.fromEntries(
      entry.lines.map((l) => [
        `${l.accountCode}${l.debit.gt(0) ? 'D' : 'C'}`,
        S(l.debit.gt(0) ? l.debit : l.credit),
      ]),
    );

  it('sales invoice: Dr receivable / Cr revenue + output VAT', () => {
    const e = journal.fromInvoice(
      {
        direction: 'sales',
        number: 'S-1',
        issueDate: '2030-05-01',
        lines: [
          { description: 'Service A', net: '100.00', vat: '18.00', treatment: 'taxable' },
          {
            description: 'Export B',
            net: '50.00',
            vat: '0.00',
            treatment: 'zero_rated',
            accountCode: '602',
          },
        ],
      },
      MAP,
    );
    expect(e.status).toBe('proposed');
    expect(e.source).toBe('invoice');
    expect(totals(e)).toEqual({
      '211D': '168.00',
      '601C': '100.00',
      '602C': '50.00',
      '533C': '18.00',
    });
    expect(journal.validate(e.lines).ok).toBe(true);
    expect(e.lines[0]?.accountCode).toBe('211'); // debetlər əvvəl
  });

  it('purchase invoice: Dr expense + input VAT / Cr payable', () => {
    const e = journal.fromInvoice(
      {
        direction: 'purchase',
        number: 'P-1',
        issueDate: '2030-05-01',
        lines: [
          {
            description: 'Goods',
            net: '100.00',
            vat: '18.00',
            treatment: 'taxable',
            accountCode: '201',
          },
        ],
      },
      MAP,
    );
    expect(totals(e)).toEqual({ '201D': '100.00', '241D': '18.00', '521C': '118.00' });
  });

  it('non-deductible input VAT is capitalised into the expense', () => {
    const e = journal.fromInvoice(
      {
        direction: 'purchase',
        number: 'P-2',
        issueDate: '2030-05-01',
        vatDeductible: false,
        lines: [
          { description: 'Entertainment', net: '100.00', vat: '18.00', treatment: 'taxable' },
        ],
      },
      MAP,
    );
    expect(totals(e)).toEqual({ '731D': '118.00', '521C': '118.00' });
    expect(e.lines.find((l) => l.accountCode === '241')).toBeUndefined();
  });

  it('exempt lines produce no VAT row', () => {
    const e = journal.fromInvoice(
      {
        direction: 'sales',
        number: 'S-2',
        issueDate: '2030-05-01',
        lines: [{ description: 'Exempt', net: '70.00', vat: '0.00', treatment: 'exempt' }],
      },
      MAP,
    );
    expect(e.lines.map((l) => l.accountCode).sort()).toEqual(['211', '601']);
  });

  it('a credit note (negative amounts) flips the sides but stays balanced', () => {
    const e = journal.fromInvoice(
      {
        direction: 'sales',
        number: 'CN-1',
        issueDate: '2030-05-01',
        lines: [{ description: 'Return', net: '-100.00', vat: '-18.00', treatment: 'taxable' }],
      },
      MAP,
    );
    expect(totals(e)).toEqual({ '601D': '100.00', '533D': '18.00', '211C': '118.00' });
    expect(journal.validate(e.lines).ok).toBe(true);
  });

  it('merges lines hitting the same account and uses the line account over the default', () => {
    const e = journal.fromInvoice(
      {
        direction: 'sales',
        number: 'S-3',
        issueDate: '2030-05-01',
        lines: [
          { description: 'x', net: '10.00', vat: '1.80', treatment: 'taxable' },
          { description: 'x', net: '20.00', vat: '3.60', treatment: 'taxable' },
        ],
      },
      MAP,
    );
    expect(totals(e)['601C']).toBe('30.00');
    expect(totals(e)['533C']).toBe('5.40');
  });

  it('refuses to propose an entry it cannot balance/represent (sub-qəpik amounts)', () => {
    expect(() =>
      journal.fromInvoice(
        {
          direction: 'sales',
          number: 'S-4',
          issueDate: '2030-05-01',
          lines: [{ description: 'x', net: '10.005', vat: '0', treatment: 'taxable' }],
        },
        MAP,
      ),
    ).toThrowError(journal.JournalError);
  });

  it('is deterministic and documents each line', () => {
    const inv: journal.JournalInvoice = {
      direction: 'sales',
      number: 'S-5',
      issueDate: '2030-05-01',
      lines: [{ description: 'a', net: '1.00', vat: '0.18', treatment: 'taxable' }],
    };
    const a = journal.fromInvoice(inv, MAP);
    const b = journal.fromInvoice(inv, MAP);
    expect(a).toEqual(b);
    expect(a.explanation.join('\n')).toContain('Dr 211 gross 1.18');
  });
});

// ---------------------------------------------------------------- vat deposit
describe('vatDeposit.reconcile', () => {
  const stmt = (
    id: string,
    date: string,
    amount: string,
    reference: string | null,
    voen: string | null = null,
    operation: vatDeposit.DepositOperation = 'vat_payment',
  ) => ({
    id,
    date,
    operation,
    amount,
    reference,
    counterpartyVoen: voen,
  });
  const led = (
    id: string,
    date: string,
    amount: string,
    reference: string | null,
    voen: string | null = null,
  ) => ({
    id,
    date,
    amount,
    reference,
    counterpartyVoen: voen,
  });
  const kinds = (m: vatDeposit.DepositMatch[]) =>
    m.map((x) => `${x.kind}:${x.statementLineId ?? '-'}/${x.ledgerEntryId ?? '-'}`);

  it('matches by reference+amount, then amount+VÖEN+date window, flags mismatches, and lists leftovers', () => {
    const matches = vatDeposit.reconcile(
      [
        stmt('s1', '2030-03-01', '18.00', 'AA 0001'),
        stmt('s2', '2030-03-02', '36.00', null, '1111111111'),
        stmt('s3', '2030-03-03', '90.00', 'AA-0003'),
        stmt('s4', '2030-03-04', '5.00', 'ZZ9'),
        stmt('s5', '2030-03-05', '500.00', null, null, 'top_up'),
      ],
      [
        led('l1', '2030-03-01', '18.00', 'aa0001'),
        led('l2', '2030-03-03', '36.00', null, '1111111111'),
        led('l3', '2030-03-03', '99.00', 'AA0003'),
        led('l4', '2030-03-10', '7.77', 'LATE'),
      ],
    );
    expect(kinds(matches)).toEqual([
      'exact_reference:s1/l1',
      'amount_party_date:s2/l2',
      'amount_mismatch:s3/l3',
      'unmatched_statement:s4/-',
      'unmatched_statement:s5/-',
      'unmatched_ledger:-/l4',
    ]);
    const mismatch = matches.find((m) => m.kind === 'amount_mismatch')!;
    expect(S(mismatch.difference)).toBe('-9.00');
    expect(mismatch.explanation).toMatch(/amounts differ/);

    const summary = vatDeposit.summarize(matches);
    expect(summary).toMatchObject({
      matched: 2,
      needsReview: 1,
      unmatchedStatement: 2,
      unmatchedLedger: 1,
    });
    expect(S(summary.statementTotal)).toBe('649.00');
    expect(S(summary.ledgerTotal)).toBe('160.77');
    expect(S(summary.balanceDifference)).toBe('488.23');
  });

  it('never guesses between several equally good candidates', () => {
    const matches = vatDeposit.reconcile(
      [stmt('s1', '2030-03-05', '10.00', null, '2222222222')],
      [
        led('l1', '2030-03-04', '10.00', null, '2222222222'),
        led('l2', '2030-03-06', '10.00', null, '2222222222'),
      ],
    );
    expect(kinds(matches)).toEqual([
      'unmatched_statement:s1/-',
      'unmatched_ledger:-/l1',
      'unmatched_ledger:-/l2',
    ]);
  });

  it('respects the date window and the one-to-one rule', () => {
    const far = vatDeposit.reconcile(
      [stmt('s1', '2030-03-20', '10.00', null, '3333333333')],
      [led('l1', '2030-03-01', '10.00', null, '3333333333')],
    );
    expect(far.every((m) => m.kind.startsWith('unmatched'))).toBe(true);
    const wide = vatDeposit.reconcile(
      [stmt('s1', '2030-03-20', '10.00', null, '3333333333')],
      [led('l1', '2030-03-01', '10.00', null, '3333333333')],
      { dateWindowDays: 30 },
    );
    expect(wide[0]?.kind).toBe('amount_party_date');

    const dup = vatDeposit.reconcile(
      [stmt('s1', '2030-03-01', '5.00', 'R1'), stmt('s2', '2030-03-01', '5.00', 'R1')],
      [led('l1', '2030-03-01', '5.00', 'R1')],
    );
    expect(kinds(dup)).toEqual(['exact_reference:s1/l1', 'unmatched_statement:s2/-']);
  });

  it('is independent of input order', () => {
    const s = [stmt('s2', '2030-03-02', '2.00', 'B'), stmt('s1', '2030-03-01', '1.00', 'A')];
    const l = [led('l2', '2030-03-02', '2.00', 'B'), led('l1', '2030-03-01', '1.00', 'A')];
    expect(kinds(vatDeposit.reconcile(s, l))).toEqual(
      kinds(vatDeposit.reconcile([...s].reverse(), [...l].reverse())),
    );
  });

  it('a fully reconciled account has a zero balance difference', () => {
    const m = vatDeposit.reconcile(
      [stmt('s1', '2030-03-01', '18.00', 'A')],
      [led('l1', '2030-03-01', '18.00', 'A')],
    );
    expect(S(vatDeposit.summarize(m).balanceDifference)).toBe('0.00');
  });
});

// -------------------------------------------------------------- invoice.check
const GOOD: invoice.InvoiceInput = {
  direction: 'purchase',
  number: 'AA 0001234',
  issueDate: '2030-05-01',
  counterparty: { voen: '1234567891', isVatPayer: true },
  currency: 'AZN',
  net: '150.00',
  vat: '27.00',
  gross: '177.00',
  lines: [
    {
      description: 'Item A',
      qty: '2',
      unitPrice: '25.00',
      vatRateCode: 'STANDARD',
      net: '50.00',
      vat: '9.00',
    },
    {
      description: 'Item B',
      qty: '1',
      unitPrice: '100.00',
      vatRateCode: 'STANDARD',
      net: '100.00',
      vat: '18.00',
    },
  ],
};
const check = (inv: invoice.InvoiceInput, ctx: Partial<invoice.CheckContext> = {}) =>
  invoice.check(inv, { rates: R, rounding: DEFAULT_ROUNDING, ...ctx });
const codes = (issues: invoice.InvoiceIssue[]) => issues.map((i) => i.code);

describe('invoice.check', () => {
  it('a consistent invoice has no issues', () => {
    expect(check(GOOD)).toEqual([]);
  });

  it('VAT_RATE_MISMATCH: wrong rate for the date, with expected vs implied rate in the message', () => {
    const inv = {
      ...GOOD,
      lines: [{ ...GOOD.lines[0]!, vat: '10.00' }, GOOD.lines[1]!],
      vat: '28.00',
      gross: '178.00',
    };
    const issues = check(inv);
    expect(codes(issues)).toEqual(['VAT_RATE_MISMATCH']);
    expect(issues[0]).toMatchObject({ severity: 'error', lineIndex: 0, field: 'vat' });
    expect(issues[0]!.message).toMatch(/expected 9\.00, implied 20%/);
  });

  it('uses the rate in force on the invoice date (18% before, 20% after the change)', () => {
    const afterChange = { ...GOOD, issueDate: '2030-07-01' };
    expect(codes(check(afterChange))).toEqual(['VAT_RATE_MISMATCH', 'VAT_RATE_MISMATCH']); // 18% artıq yanlışdır
    const fixed = {
      ...afterChange,
      vat: '30.00',
      gross: '180.00',
      lines: [
        { ...GOOD.lines[0]!, vat: '10.00' },
        { ...GOOD.lines[1]!, vat: '20.00' },
      ],
    };
    expect(check(fixed)).toEqual([]);
  });

  it('RATE_NOT_FOUND for an unknown rate code', () => {
    const inv = { ...GOOD, lines: [{ ...GOOD.lines[0]!, vatRateCode: 'WAT' }, GOOD.lines[1]!] };
    expect(codes(check(inv))).toContain('RATE_NOT_FOUND');
  });

  it('TOTAL_MISMATCH: lines vs header, and net + vat vs gross', () => {
    expect(
      check({ ...GOOD, net: '151.00', gross: '178.00' }).map((i) => `${i.code}:${i.field}`),
    ).toEqual(['TOTAL_MISMATCH:net']);
    expect(
      check({ ...GOOD, vat: '28.00', gross: '178.00' }).map((i) => `${i.code}:${i.field}`),
    ).toEqual(['TOTAL_MISMATCH:vat']);
    expect(check({ ...GOOD, gross: '170.00' }).map((i) => `${i.code}:${i.field}`)).toEqual([
      'TOTAL_MISMATCH:gross',
    ]);
  });

  it('LINE_NET_MISMATCH: qty × unit price ≠ net', () => {
    const inv = { ...GOOD, lines: [{ ...GOOD.lines[0]!, qty: '3' }, GOOD.lines[1]!] };
    const issues = check(inv);
    expect(codes(issues)).toEqual(['LINE_NET_MISMATCH']);
    expect(issues[0]!.message).toContain('= 75.00 but net is 50.00');
  });

  it('tolerates penny rounding differences but not more', () => {
    const penny = {
      ...GOOD,
      lines: [{ ...GOOD.lines[0]!, vat: '9.01' }, GOOD.lines[1]!],
      vat: '27.01',
      gross: '177.01',
    };
    expect(check(penny)).toEqual([]);
    const two = {
      ...GOOD,
      lines: [{ ...GOOD.lines[0]!, vat: '9.02' }, GOOD.lines[1]!],
      vat: '27.02',
      gross: '177.02',
    };
    expect(codes(check(two))).toContain('VAT_RATE_MISMATCH');
    expect(check(two, { tolerance: '0.05' })).toEqual([]);
  });

  it('INVALID_TAX_ID, INVALID_DATE and FUTURE_DATE', () => {
    expect(codes(check({ ...GOOD, counterparty: { voen: '12345' } }))).toEqual(['INVALID_TAX_ID']);
    const bad = check({ ...GOOD, issueDate: '2030-02-30' });
    expect(codes(bad)).toContain('INVALID_DATE');
    expect(codes(bad)).not.toContain('VAT_RATE_MISMATCH'); // tarix yoxdursa dərəcə yoxlanmır
    const future = check(GOOD, { today: '2030-04-30' });
    expect(future).toEqual([expect.objectContaining({ code: 'FUTURE_DATE', severity: 'warning' })]);
    expect(check(GOOD, { today: '2030-05-01' })).toEqual([]);
  });

  it('DUPLICATE_INVOICE matches direction + normalised number + counterparty', () => {
    const existing = [
      {
        id: 'inv-9',
        direction: 'purchase' as const,
        number: 'aa  0001234',
        counterpartyVoen: '1234567891',
      },
    ];
    expect(codes(check(GOOD, { existing }))).toEqual(['DUPLICATE_INVOICE']);
    expect(
      check(GOOD, { existing: [{ ...existing[0]!, counterpartyVoen: '9999999999' }] }),
    ).toEqual([]);
    expect(check(GOOD, { existing: [{ ...existing[0]!, direction: 'sales' }] })).toEqual([]);
  });

  it('VAT_FROM_NON_PAYER warns when a non-payer charges VAT', () => {
    const issues = check({ ...GOOD, counterparty: { voen: '1234567891', isVatPayer: false } });
    expect(issues).toEqual([
      expect.objectContaining({ code: 'VAT_FROM_NON_PAYER', severity: 'warning' }),
    ]);
  });

  it('flags missing lines and unparsable amounts instead of crashing', () => {
    expect(codes(check({ ...GOOD, lines: [], net: '0', vat: '0', gross: '0' }))).toEqual([
      'NO_LINES',
    ]);
    expect(codes(check({ ...GOOD, net: 'abc' }))).toEqual(['INVALID_AMOUNT']);
    expect(codes(check({ ...GOOD, lines: [{ ...GOOD.lines[0]!, qty: 'x' }] }))).toContain(
      'INVALID_AMOUNT',
    );
  });

  it('exempt/zero-rated lines must carry zero VAT', () => {
    const inv = {
      ...GOOD,
      lines: [
        {
          description: 'Exempt',
          qty: '1',
          unitPrice: '100.00',
          vatRateCode: 'EXEMPT',
          net: '100.00',
          vat: '18.00',
        },
      ],
      net: '100.00',
      vat: '18.00',
      gross: '118.00',
    };
    expect(codes(check(inv))).toEqual(['VAT_RATE_MISMATCH']);
  });
});

describe('invoice.computeTotals — line vs total rounding is configuration', () => {
  const lines = [
    { qty: '1', unitPrice: '0.25', vatRateCode: 'STANDARD' },
    { qty: '1', unitPrice: '0.25', vatRateCode: 'STANDARD' },
    { qty: '1', unitPrice: '0.25', vatRateCode: 'STANDARD' },
  ];
  it('line level: each VAT is rounded (3 × 0.05 = 0.15)', () => {
    const t = invoice.computeTotals(lines, '2030-05-01', R, { ...DEFAULT_ROUNDING, level: 'line' });
    expect(t.lines.map((l) => S(l.vat))).toEqual(['0.05', '0.05', '0.05']);
    expect([S(t.net), S(t.vat), S(t.gross)]).toEqual(['0.75', '0.15', '0.90']);
  });
  it('total level: exact sum 0.135 rounded once (0.14), residue pushed onto a line so rows still add up', () => {
    const t = invoice.computeTotals(lines, '2030-05-01', R, {
      ...DEFAULT_ROUNDING,
      level: 'total',
    });
    expect(S(t.vat)).toBe('0.14');
    expect(t.lines.map((l) => S(l.vat))).toEqual(['0.04', '0.05', '0.05']);
    expect(t.lines.reduce((a, l) => a.plus(l.vat), t.vat.minus(t.vat)).eq(t.vat)).toBe(true);
  });
  it('groups the net and VAT by rate code with their treatment (for the VAT return)', () => {
    const t = invoice.computeTotals(
      [
        { qty: '2', unitPrice: '50.00', vatRateCode: 'STANDARD' },
        { qty: '1', unitPrice: '30.00', vatRateCode: 'ZERO' },
        { qty: '1', unitPrice: '20.00', vatRateCode: 'EXEMPT' },
      ],
      '2030-05-01',
      R,
    );
    expect(Object.keys(t.byRate).sort()).toEqual(['EXEMPT', 'STANDARD', 'ZERO']);
    expect(t.byRate['STANDARD']).toMatchObject({ treatment: 'taxable' });
    expect(S(t.byRate['STANDARD']!.vat)).toBe('18.00');
    expect(t.byRate['ZERO']).toMatchObject({ treatment: 'zero_rated' });
    expect(t.byRate['EXEMPT']).toMatchObject({ treatment: 'exempt' });
    expect([S(t.net), S(t.vat), S(t.gross)]).toEqual(['150.00', '18.00', '168.00']);
  });
  it('fails when a rate is missing on the date', () => {
    expect(() =>
      invoice.computeTotals([{ qty: '1', unitPrice: '1', vatRateCode: 'NOPE' }], '2030-05-01', R),
    ).toThrow();
  });
});

describe('taxId.buildIbanAz input guard', () => {
  it('refuses malformed bank code / account', () => {
    expect(() => taxId.buildIbanAz('NAB', '00000000137010001944')).toThrow();
    expect(() => taxId.buildIbanAz('NABZ', '123')).toThrow();
  });
});

describe('invoice.check — broken rate tables', () => {
  it('reports an ambiguous/invalid rate table as RATE_CONFIG_ERROR (not as a missing rate)', () => {
    const ambiguous = [
      ...R,
      taxRate({
        id: 'dup',
        taxType: 'VAT',
        code: 'STANDARD',
        ratePercent: '19',
        validFrom: '2030-04-01',
        validTo: '2030-06-30',
      }),
    ];
    const issues = invoice.check(GOOD, { rates: ambiguous });
    expect(issues.map((i) => i.code)).toEqual(['RATE_CONFIG_ERROR', 'RATE_CONFIG_ERROR']);
    expect(issues[0]?.message).toMatch(/overlapping/);
  });

  it('does not swallow programming errors', () => {
    const corrupt = [{ ...R[0]!, ratePercent: null as never }];
    expect(() => invoice.check(GOOD, { rates: corrupt })).toThrow(TypeError);
  });
});

describe('payroll (phase 2 placeholder)', () => {
  it('refuses to compute anything rather than returning wrong numbers', () => {
    expect(payroll.PAYROLL_PHASE).toBe(2);
    expect(() => payroll.calculate()).toThrowError(
      expect.objectContaining({ code: 'NOT_IMPLEMENTED' }),
    );
  });
});
