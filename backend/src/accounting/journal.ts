import type { LocalDate } from './dates.js';
import { ZERO, dec, formatAmount, sum, type AmountInput, type Dec } from './money.js';
import type { VatTreatment } from './rates.js';

export interface JournalLineInput {
  accountCode: string;
  debit: AmountInput;
  credit: AmountInput;
  description?: string | null;
}

export interface JournalLine {
  accountCode: string;
  debit: Dec;
  credit: Dec;
  description: string | null;
}

export type JournalIssueCode =
  | 'TOO_FEW_LINES'
  | 'INVALID_AMOUNT'
  | 'NEGATIVE_AMOUNT'
  | 'EXCESS_PRECISION'
  | 'BOTH_SIDES'
  | 'ZERO_LINE'
  | 'INVALID_ACCOUNT_CODE'
  | 'UNKNOWN_ACCOUNT'
  | 'UNBALANCED';

export interface JournalIssue {
  code: JournalIssueCode;
  lineIndex?: number;
  message: string;
}

export type JournalValidation =
  { ok: true; totalDebit: Dec; totalCredit: Dec } | { ok: false; issues: JournalIssue[] };

export class JournalError extends Error {
  constructor(readonly issues: JournalIssue[]) {
    super(`Invalid journal entry: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'JournalError';
  }
}

export interface ValidateOptions {
  /** Hesablar planındakı kodlar; verilərsə, kodlar bu siyahıda olmalıdır. */
  chart?: ReadonlySet<string> | readonly string[];
  /** Maksimum onluq rəqəm (AZN: 2). */
  scale?: number;
}

const ACCOUNT_CODE = /^\d{3,6}$/;

/** Jurnal yazılışı qaydaları: ≥2 sətir, hər sətir bir tərəfdə müsbət məbləğ, hesab kodu etibarlı, Σdebet = Σkredit. */
export function validate(
  lines: readonly JournalLineInput[],
  opts: ValidateOptions = {},
): JournalValidation {
  const issues: JournalIssue[] = [];
  const scale = opts.scale ?? 2;
  const chart = opts.chart ? new Set(opts.chart) : null;
  const parsed: Array<{ debit: Dec; credit: Dec }> = [];

  if (lines.length < 2) {
    issues.push({ code: 'TOO_FEW_LINES', message: 'A journal entry needs at least two lines' });
  }

  lines.forEach((line, i) => {
    let debit = ZERO;
    let credit = ZERO;
    let parsable = true;
    try {
      debit = dec(line.debit, `line ${i + 1} debit`);
      credit = dec(line.credit, `line ${i + 1} credit`);
    } catch (e) {
      parsable = false;
      issues.push({ code: 'INVALID_AMOUNT', lineIndex: i, message: (e as Error).message });
    }
    if (parsable) {
      if (debit.isNegative() || credit.isNegative()) {
        issues.push({
          code: 'NEGATIVE_AMOUNT',
          lineIndex: i,
          message: `Line ${i + 1}: amounts must not be negative`,
        });
      }
      if (debit.decimalPlaces() > scale || credit.decimalPlaces() > scale) {
        issues.push({
          code: 'EXCESS_PRECISION',
          lineIndex: i,
          message: `Line ${i + 1}: more than ${scale} decimal places`,
        });
      }
      if (debit.gt(0) && credit.gt(0)) {
        issues.push({
          code: 'BOTH_SIDES',
          lineIndex: i,
          message: `Line ${i + 1}: debit and credit are both set`,
        });
      } else if (debit.isZero() && credit.isZero()) {
        issues.push({ code: 'ZERO_LINE', lineIndex: i, message: `Line ${i + 1}: amount is zero` });
      }
    }
    parsed.push({ debit, credit });

    if (!ACCOUNT_CODE.test(line.accountCode)) {
      issues.push({
        code: 'INVALID_ACCOUNT_CODE',
        lineIndex: i,
        message: `Line ${i + 1}: account code "${line.accountCode}" must be 3-6 digits`,
      });
    } else if (chart && !chart.has(line.accountCode)) {
      issues.push({
        code: 'UNKNOWN_ACCOUNT',
        lineIndex: i,
        message: `Line ${i + 1}: account ${line.accountCode} is not in the chart of accounts`,
      });
    }
  });

  const totalDebit = sum(parsed.map((p) => p.debit));
  const totalCredit = sum(parsed.map((p) => p.credit));
  if (!totalDebit.eq(totalCredit)) {
    issues.push({
      code: 'UNBALANCED',
      message: `Total debit ${formatAmount(totalDebit, scale)} ≠ total credit ${formatAmount(totalCredit, scale)}`,
    });
  }
  return issues.length === 0 ? { ok: true, totalDebit, totalCredit } : { ok: false, issues };
}

export function assertValid(lines: readonly JournalLineInput[], opts: ValidateOptions = {}): void {
  const res = validate(lines, opts);
  if (!res.ok) throw new JournalError(res.issues);
}

// ---------------------------------------------------------------- from_invoice

/** Şirkətin hesablar planına görə rol → hesab kodu. Mühərrikdə sabit kod YOXDUR (plan şirkətə görə dəyişir). */
export interface AccountMapping {
  receivable: string;
  payable: string;
  revenue: string;
  expense: string;
  vatOutput: string;
  vatInput: string;
}

export interface JournalInvoiceLine {
  description: string;
  /** Baza valyutada. */
  net: AmountInput;
  vat: AmountInput;
  treatment: VatTreatment;
  /** `account_final ?? account_suggestion`; yoxdursa mapping.revenue/expense. */
  accountCode?: string | null;
}

export interface JournalInvoice {
  direction: 'sales' | 'purchase';
  number: string;
  issueDate: LocalDate;
  lines: readonly JournalInvoiceLine[];
  /** Alış qaiməsində ƏDV əvəzləşdirilə bilərmi (default true). false → ƏDV xərcə aid edilir. */
  vatDeductible?: boolean;
}

export interface ProposedEntry {
  date: LocalDate;
  description: string;
  status: 'proposed';
  source: 'invoice';
  lines: JournalLine[];
  explanation: string[];
}

class Builder {
  private readonly rows: JournalLine[] = [];
  add(side: 'debit' | 'credit', accountCode: string, amount: Dec, description: string): void {
    if (amount.isZero()) return;
    // mənfi məbləğ (kredit-nota) əks tərəfə yazılır
    const effective = amount.isNegative() ? (side === 'debit' ? 'credit' : 'debit') : side;
    const abs = amount.abs();
    const existing = this.rows.find(
      (r) => r.accountCode === accountCode && r[effective].gt(0) && r.description === description,
    );
    if (existing) existing[effective] = existing[effective].plus(abs);
    else {
      this.rows.push({
        accountCode,
        debit: effective === 'debit' ? abs : ZERO,
        credit: effective === 'credit' ? abs : ZERO,
        description,
      });
    }
  }
  lines(): JournalLine[] {
    // debetlər əvvəl, sonra kreditlər (oxunaqlı yazılış); hər qrupda əlavə sırası saxlanılır
    return [...this.rows.filter((r) => r.debit.gt(0)), ...this.rows.filter((r) => r.credit.gt(0))];
  }
}

/**
 * Qaimədən TƏKLİF olunan jurnal yazılışı (status = proposed; təsdiq və post ayrıca addımdır).
 *  Satış:  Dr Alıcılar (gross) / Cr Gəlir (net, sətir üzrə) / Cr ƏDV-hesablanmış
 *  Alış:   Dr Xərc/Ehtiyat (net) / Dr ƏDV-əvəzləşdirilən / Cr Təchizatçılar (gross)
 * Azadolma/sıfır dərəcəli sətirlərdə ƏDV sətri yaranmır. Yazılış qurulma etibarilə balanslıdır və yoxlanılır.
 */
export function fromInvoice(invoice: JournalInvoice, mapping: AccountMapping): ProposedEntry {
  const b = new Builder();
  const explanation: string[] = [];
  const deductible = invoice.vatDeductible ?? true;
  const label = invoice.direction === 'sales' ? 'Sales' : 'Purchase';
  const desc = `${label} invoice ${invoice.number}`;

  let totalNet = ZERO;
  let totalVat = ZERO;

  invoice.lines.forEach((line, i) => {
    const net = dec(line.net, `line ${i + 1} net`);
    const vat = dec(line.vat, `line ${i + 1} vat`);
    totalNet = totalNet.plus(net);
    totalVat = totalVat.plus(vat);
    const account =
      line.accountCode || (invoice.direction === 'sales' ? mapping.revenue : mapping.expense);
    const text = line.description || desc;

    if (invoice.direction === 'sales') {
      b.add('credit', account, net, text);
      b.add('credit', mapping.vatOutput, vat, `Output VAT — ${desc}`);
      explanation.push(
        `Line ${i + 1}: Cr ${account} net ${formatAmount(net)}; Cr ${mapping.vatOutput} VAT ${formatAmount(vat)}`,
      );
    } else if (deductible) {
      b.add('debit', account, net, text);
      b.add('debit', mapping.vatInput, vat, `Input VAT — ${desc}`);
      explanation.push(
        `Line ${i + 1}: Dr ${account} net ${formatAmount(net)}; Dr ${mapping.vatInput} VAT ${formatAmount(vat)}`,
      );
    } else {
      b.add('debit', account, net.plus(vat), text);
      explanation.push(
        `Line ${i + 1}: VAT is not deductible → Dr ${account} ${formatAmount(net.plus(vat))} (net + VAT)`,
      );
    }
  });

  const gross = totalNet.plus(totalVat);
  if (invoice.direction === 'sales') b.add('debit', mapping.receivable, gross, desc);
  else b.add('credit', mapping.payable, gross, desc);
  explanation.push(
    `${invoice.direction === 'sales' ? 'Dr' : 'Cr'} ${
      invoice.direction === 'sales' ? mapping.receivable : mapping.payable
    } gross ${formatAmount(gross)}`,
  );

  const lines = b.lines();
  const check = validate(
    lines.map((l) => ({ accountCode: l.accountCode, debit: l.debit, credit: l.credit })),
  );
  if (!check.ok) {
    // Qurulma invariantı pozulubsa (məs. 2-dən çox onluq) — saxta yazılış təklif etmirik
    throw new JournalError(check.issues);
  }
  return {
    date: invoice.issueDate,
    description: desc,
    status: 'proposed',
    source: 'invoice',
    lines,
    explanation,
  };
}
