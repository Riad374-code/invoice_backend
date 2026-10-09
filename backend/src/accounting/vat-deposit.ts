import { compareDates, daysBetween, type LocalDate } from './dates.js';
import { D, ZERO, dec, type AmountInput, type Dec } from './money.js';

/**
 * ƏDV depozit hesabı ↔ uçot uzlaşdırması.
 * Dövlət Vergi Xidmətinin depozit hesabı çıxarışı (statement) ilə şirkətin mühasibat yazılışları (ledger)
 * cütləşdirilir. Alqoritm deterministikdir (AI yoxdur): hər çıxarış sətri ən çoxu bir uçot yazılışı ilə
 * uyğunlaşır; qeyri-müəyyən hallarda uyğunlaşdırma EDİLMİR (insan qərar verir).
 */
export type DepositOperation = 'top_up' | 'vat_payment' | 'refund' | 'withdrawal' | 'other';

export interface DepositStatementLine {
  id: string;
  date: LocalDate;
  operation: DepositOperation;
  /** Mütləq (müsbət) məbləğ; istiqamət `operation`-dan çıxır. */
  amount: AmountInput;
  /** Qaimə nömrəsi / ödəniş istinadı. */
  reference?: string | null;
  counterpartyVoen?: string | null;
}

export interface DepositLedgerEntry {
  id: string;
  date: LocalDate;
  amount: AmountInput;
  reference?: string | null;
  counterpartyVoen?: string | null;
  invoiceId?: string | null;
}

export type DepositMatchKind =
  | 'exact_reference' // istinad + məbləğ eynidir
  | 'amount_party_date' // məbləğ + VÖEN eyni, tarix pəncərəsində, tək namizəd
  | 'amount_mismatch' // istinad eynidir, məbləğ fərqlidir → yoxlama tələb edir
  | 'unmatched_statement' // çıxarışda var, uçotda yoxdur
  | 'unmatched_ledger'; // uçotda var, çıxarışda yoxdur

export interface DepositMatch {
  kind: DepositMatchKind;
  statementLineId: string | null;
  ledgerEntryId: string | null;
  statementAmount: Dec | null;
  ledgerAmount: Dec | null;
  /** statement − ledger (uyğunlaşmayanlarda tam məbləğ). */
  difference: Dec;
  confidence: Dec;
  explanation: string;
}

export interface ReconcileOptions {
  /** `amount_party_date` üçün tarix fərqi pəncərəsi (gün). */
  dateWindowDays?: number;
}

const normRef = (r: string | null | undefined): string =>
  (r ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normVoen = (v: string | null | undefined): string => (v ?? '').replace(/\s+/g, '');
const byDateThenId = <T extends { date: LocalDate; id: string }>(a: T, b: T) =>
  compareDates(a.date, b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

interface S {
  line: DepositStatementLine;
  amount: Dec;
  ref: string;
  voen: string;
}
interface L {
  entry: DepositLedgerEntry;
  amount: Dec;
  ref: string;
  voen: string;
}

export function reconcile(
  statement: readonly DepositStatementLine[],
  ledger: readonly DepositLedgerEntry[],
  opts: ReconcileOptions = {},
): DepositMatch[] {
  const window = opts.dateWindowDays ?? 3;
  const stmt: S[] = [...statement].sort(byDateThenId).map((line) => ({
    line,
    amount: dec(line.amount, `statement ${line.id} amount`),
    ref: normRef(line.reference),
    voen: normVoen(line.counterpartyVoen),
  }));
  const led: L[] = [...ledger].sort(byDateThenId).map((entry) => ({
    entry,
    amount: dec(entry.amount, `ledger ${entry.id} amount`),
    ref: normRef(entry.reference),
    voen: normVoen(entry.counterpartyVoen),
  }));

  const matches: DepositMatch[] = [];
  const usedS = new Set<string>();
  const usedL = new Set<string>();
  const freeL = () => led.filter((l) => !usedL.has(l.entry.id));
  const freeS = () => stmt.filter((s) => !usedS.has(s.line.id));

  const link = (s: S, l: L, kind: DepositMatchKind, confidence: string, explanation: string) => {
    usedS.add(s.line.id);
    usedL.add(l.entry.id);
    matches.push({
      kind,
      statementLineId: s.line.id,
      ledgerEntryId: l.entry.id,
      statementAmount: s.amount,
      ledgerAmount: l.amount,
      difference: s.amount.minus(l.amount),
      confidence: new D(confidence),
      explanation,
    });
  };

  // 1) istinad + məbləğ
  for (const s of freeS()) {
    if (!s.ref) continue;
    const hit = freeL().find((l) => l.ref === s.ref && l.amount.eq(s.amount));
    if (hit)
      link(
        s,
        hit,
        'exact_reference',
        '1',
        `Reference ${s.line.reference} and amount ${s.amount.toFixed(2)} are identical`,
      );
  }

  // 2) məbləğ + VÖEN + tarix pəncərəsi — YALNIZ tək namizəd olduqda
  for (const s of freeS()) {
    if (!s.voen) continue;
    const candidates = freeL().filter(
      (l) =>
        l.voen === s.voen &&
        l.amount.eq(s.amount) &&
        Math.abs(daysBetween(l.entry.date, s.line.date)) <= window,
    );
    if (candidates.length === 1) {
      const l = candidates[0]!;
      link(
        s,
        l,
        'amount_party_date',
        '0.9',
        `Same amount ${s.amount.toFixed(2)} and counterparty ${s.voen} within ${window} day(s) (${l.entry.date} ↔ ${s.line.date})`,
      );
    }
  }

  // 3) istinad eynidir, məbləğ fərqlidir
  for (const s of freeS()) {
    if (!s.ref) continue;
    const hit = freeL().find((l) => l.ref === s.ref);
    if (hit) {
      link(
        s,
        hit,
        'amount_mismatch',
        '0.7',
        `Reference ${s.line.reference} matches but amounts differ: statement ${s.amount.toFixed(2)} vs ledger ${hit.amount.toFixed(2)}`,
      );
    }
  }

  // 4) qalıqlar
  for (const s of freeS()) {
    matches.push({
      kind: 'unmatched_statement',
      statementLineId: s.line.id,
      ledgerEntryId: null,
      statementAmount: s.amount,
      ledgerAmount: null,
      difference: s.amount,
      confidence: ZERO,
      explanation: `Deposit statement line ${s.line.id} (${s.line.operation}, ${s.line.date}) has no ledger entry`,
    });
  }
  for (const l of freeL()) {
    matches.push({
      kind: 'unmatched_ledger',
      statementLineId: null,
      ledgerEntryId: l.entry.id,
      statementAmount: null,
      ledgerAmount: l.amount,
      difference: l.amount.negated(),
      confidence: ZERO,
      explanation: `Ledger entry ${l.entry.id} (${l.entry.date}) is not on the deposit statement`,
    });
  }
  return matches;
}

export interface ReconciliationSummary {
  matched: number;
  needsReview: number;
  unmatchedStatement: number;
  unmatchedLedger: number;
  statementTotal: Dec;
  ledgerTotal: Dec;
  /** statementTotal − ledgerTotal: 0 olduqda deposit hesabı uçotla uzlaşıb. */
  balanceDifference: Dec;
}

export function summarize(matches: readonly DepositMatch[]): ReconciliationSummary {
  let statementTotal = ZERO;
  let ledgerTotal = ZERO;
  const summary = { matched: 0, needsReview: 0, unmatchedStatement: 0, unmatchedLedger: 0 };
  for (const m of matches) {
    if (m.statementAmount) statementTotal = statementTotal.plus(m.statementAmount);
    if (m.ledgerAmount) ledgerTotal = ledgerTotal.plus(m.ledgerAmount);
    if (m.kind === 'exact_reference' || m.kind === 'amount_party_date') summary.matched++;
    else if (m.kind === 'amount_mismatch') summary.needsReview++;
    else if (m.kind === 'unmatched_statement') summary.unmatchedStatement++;
    else summary.unmatchedLedger++;
  }
  return {
    ...summary,
    statementTotal,
    ledgerTotal,
    balanceDifference: statementTotal.minus(ledgerTotal),
  };
}
