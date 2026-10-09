import { D, journal, vatTreatmentOf, selectRate, type TaxRate } from '../accounting/index.js';
import type { Repos } from '../db/index.js';
import type { EntryRow, JLine } from '../db/repos/ledger.js';
import { DomainError, newApproval, type Approval } from '../domain/index.js';
import { transitionInvoice } from '../invoices/service.js';

export const DEFAULT_ACCOUNT_MAPPING: journal.AccountMapping = {
  receivable: '211',
  payable: '521',
  revenue: '601',
  expense: '731',
  vatOutput: '533',
  vatInput: '241',
};

/** A-04: jurnal yazılışı state machine: proposed → approved → posted. Geri dönüş yoxdur (düzəliş yeni yazılışla). */
const NEXT: Record<EntryRow['status'], readonly EntryRow['status'][]> = {
  proposed: ['approved'],
  approved: ['posted'],
  posted: [],
};
export function transitionEntry(
  from: EntryRow['status'],
  to: EntryRow['status'],
): EntryRow['status'] {
  if (!NEXT[from].includes(to))
    throw new DomainError(
      'INVALID_STATE_TRANSITION',
      `Journal entry cannot move from ${from} to ${to}`,
    );
  return to;
}

export interface Proposal {
  entryId: string;
  entry: journal.ProposedEntry;
}

/** Qaimədən TƏKLİF olunan jurnal yazılışını saxlayır (status = proposed). Bu qaimə üçün əvvəlki açıq təklif əvəz olunur. */
export async function persistProposalForInvoice(
  repos: Repos,
  inv: {
    id: string;
    companyId: string;
    direction: 'sales' | 'purchase';
    number: string;
    issueDate: string;
  },
  userId: string,
  opts: { mapping?: journal.AccountMapping; vatDeductible?: boolean } = {},
): Promise<Proposal> {
  const [lines, rates] = await Promise.all([
    repos.invoices.lines(inv.companyId, inv.id),
    repos.taxRates.listActive('VAT') as Promise<TaxRate[]>,
  ]);
  const entry = journal.fromInvoice(
    {
      direction: inv.direction,
      number: inv.number,
      issueDate: inv.issueDate,
      ...(opts.vatDeductible !== undefined ? { vatDeductible: opts.vatDeductible } : {}),
      lines: lines.map((l) => ({
        description: l.description,
        net: l.net,
        vat: l.vat,
        treatment: vatTreatmentOf(selectRate(rates, 'VAT', l.vatRateCode, inv.issueDate)),
        accountCode: l.accountFinal ?? l.accountSuggestion,
      })),
    },
    opts.mapping ?? DEFAULT_ACCOUNT_MAPPING,
  );
  await repos.ledger.deleteOpenProposalForInvoice(inv.companyId, inv.id);
  const entryId = await repos.ledger.createEntry({
    companyId: inv.companyId,
    entryDate: entry.date,
    description: entry.description,
    source: 'invoice',
    sourceInvoiceId: inv.id,
    createdBy: userId,
    lines: entry.lines.map((l) => ({
      accountCode: l.accountCode,
      debit: l.debit.toFixed(2),
      credit: l.credit.toFixed(2),
      description: l.description,
    })),
  });
  return { entryId, entry };
}

export interface PostingIssue {
  code: string;
  message: string;
}

/** Post etməzdən əvvəl: ≥2 sətir, Σdebet = Σkredit, hesablar şirkətin planında (plan varsa). */
export async function checkPostable(
  repos: Repos,
  companyId: string,
  lines: JLine[],
): Promise<PostingIssue[]> {
  const v = journal.validate(
    lines.map((l) => ({ accountCode: l.accountCode, debit: l.debit, credit: l.credit })),
  );
  const issues: PostingIssue[] = v.ok
    ? []
    : v.issues.map((i) => ({ code: i.code, message: i.message }));
  const chart = await repos.ledger.listAccounts(companyId);
  if (chart.length > 0) {
    const known = new Set(chart.map((a) => a.code));
    for (const l of lines)
      if (!known.has(l.accountCode))
        issues.push({
          code: 'UNKNOWN_ACCOUNT',
          message: `Account ${l.accountCode} is not in the company's chart of accounts`,
        });
  }
  return issues;
}

export class PostingError extends Error {
  constructor(readonly issues: PostingIssue[]) {
    super(`Journal entry cannot be posted: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'PostingError';
  }
}

/** Yazılışı təsdiqləyib post edir (transaksiya daxilində çağırılmalıdır). Qaimə də `posted` olur. */
export async function postEntry(
  repos: Repos,
  companyId: string,
  entryId: string,
  approvedBy: string,
  now: Date,
): Promise<EntryRow> {
  const entry = await repos.ledger.find(companyId, entryId, { forUpdate: true });
  if (!entry) throw new DomainError('NOT_FOUND', `Journal entry ${entryId} not found`);
  transitionEntry(entry.status, 'approved');
  const lines = await repos.ledger.lines(companyId, entryId);
  const issues = await checkPostable(repos, companyId, lines);
  if (issues.length) throw new PostingError(issues);

  if (entry.sourceInvoiceId) {
    const inv = await repos.invoices.lock(companyId, entry.sourceInvoiceId);
    if (!inv) throw new DomainError('NOT_FOUND', 'Source invoice not found');
    if (inv.status !== 'validated')
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        `Source invoice is ${inv.status}; only validated invoices can be booked`,
      );
    await repos.invoices.updateHeader(companyId, inv.id, {
      status: transitionInvoice(inv.status, 'posted'),
    });
  }
  const chart = await repos.ledger.listAccounts(companyId);
  if (chart.length)
    await repos.ledger.linkLineAccounts(
      companyId,
      entryId,
      new Map(chart.map((a) => [a.code, a.id])),
    );
  await repos.ledger.approveAndPost(companyId, entryId, approvedBy, now);
  return (await repos.ledger.find(companyId, entryId))!;
}

/** POST /journal/:id/submit: təsdiq sorğusu yaradır (yazılış təsdiqsiz post olunmur). Eyni yazılış üçün açıq sorğu varsa təkrar yaranmır. */
export async function requestPosting(
  repos: Repos,
  companyId: string,
  entryId: string,
  requesterId: string,
  now: Date,
): Promise<{ approval: Approval; reused: boolean }> {
  const entry = await repos.ledger.find(companyId, entryId, { forUpdate: true });
  if (!entry) throw new DomainError('NOT_FOUND', `Journal entry ${entryId} not found`);
  if (entry.status !== 'proposed')
    throw new DomainError('INVALID_STATE_TRANSITION', `Journal entry is already ${entry.status}`);
  if (entry.approvalId) {
    const existing = await repos.approvals.findById(entry.approvalId);
    if (existing && existing.status === 'pending' && existing.expiresAt > now)
      return { approval: existing, reused: true };
  }
  const lines = await repos.ledger.lines(companyId, entryId);
  const issues = await checkPostable(repos, companyId, lines);
  if (issues.length) throw new PostingError(issues);
  const totalDebit = lines.reduce((a, l) => a.plus(l.debit), new D(0)).toFixed(2);
  const approval = await repos.approvals.create(
    newApproval({
      companyId,
      kind: 'journal_post',
      resourceRef: `journal_entry:${entryId}`,
      requesterId,
      now,
      payload: {
        entryId,
        description: entry.description,
        date: entry.entryDate,
        lines: lines.length,
        totalDebit,
      },
      expiresAt: new Date(now.getTime() + 72 * 3_600_000),
    }),
  );
  await repos.ledger.setApproval(companyId, entryId, approval.id);
  return { approval, reused: false };
}
