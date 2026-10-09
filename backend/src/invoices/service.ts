import { DEFAULT_ROUNDING, invoice as engine, type TaxRate } from '../accounting/index.js';
import type { Repos } from '../db/index.js';
import type { InvoiceRow, LineRow } from '../db/repos/invoices.js';
import { DomainError } from '../domain/index.js';

/** A-04: faktura statusu state machine. posted (B11) yalnız ledger-dən gəlir; əl ilə dəyişdirilə bilməz. */
const ALLOWED: Record<InvoiceRow['status'], readonly InvoiceRow['status'][]> = {
  extracted: ['validated', 'needs_review'],
  needs_review: ['extracted', 'validated', 'needs_review'],
  validated: ['extracted', 'needs_review', 'posted'],
  posted: [],
};
export function transitionInvoice(
  from: InvoiceRow['status'],
  to: InvoiceRow['status'],
): InvoiceRow['status'] {
  if (from === to) return to;
  if (!ALLOWED[from].includes(to))
    throw new DomainError('INVALID_STATE_TRANSITION', `Invoice cannot move from ${from} to ${to}`);
  return to;
}

export interface ValidationOutcome {
  status: InvoiceRow['status'];
  issues: Array<
    Omit<engine.InvoiceIssue, 'code'> & { code: engine.InvoiceIssue['code'] | 'LOW_CONFIDENCE' }
  >;
}

/** Deterministik yoxlama (accounting.invoice.check) + invoice_issues-in yenilənməsi + status. */
export const DEFAULT_REVIEW_THRESHOLD = 0.85;

/** Etibarlılığı həddən aşağı olan sahələrin yolları (UI sarı işarələyir; insan düzəldənə qədər qalır). */
export function lowConfidenceFields(
  fc: Record<string, number>,
  threshold = DEFAULT_REVIEW_THRESHOLD,
): string[] {
  return Object.entries(fc)
    .filter(([, v]) => typeof v === 'number' && v < threshold)
    .map(([k]) => k)
    .sort();
}

export async function validateInvoice(
  repos: Repos,
  inv: InvoiceRow,
  opts: { today?: string; reviewThreshold?: number } = {},
): Promise<ValidationOutcome> {
  const today = opts.today;
  const [lines, counterparty, rates] = await Promise.all([
    repos.invoices.lines(inv.companyId, inv.id),
    inv.counterpartyId
      ? repos.invoices.getCounterparty(inv.companyId, inv.counterpartyId)
      : Promise.resolve(null),
    repos.taxRates.listActive('VAT') as Promise<TaxRate[]>,
  ]);
  const existing = await repos.invoices.sameNumber(
    inv.companyId,
    inv.direction,
    inv.number,
    inv.id,
  );
  const issues: ValidationOutcome['issues'] = engine.check(
    {
      direction: inv.direction,
      number: inv.number,
      issueDate: inv.issueDate,
      counterparty: {
        voen: counterparty?.voen ?? null,
        isVatPayer: counterparty?.isVatPayer ?? null,
      },
      currency: inv.currency,
      net: inv.net,
      vat: inv.vat,
      gross: inv.gross,
      lines: lines.map((l: LineRow) => ({
        description: l.description,
        qty: l.qty,
        unitPrice: l.unitPrice,
        vatRateCode: l.vatRateCode,
        net: l.net,
        vat: l.vat,
      })),
    },
    {
      rates,
      rounding: DEFAULT_ROUNDING,
      existing,
      ...(today ? { today } : {}),
    },
  );
  const low = lowConfidenceFields(inv.fieldConfidence, opts.reviewThreshold);
  if (low.length > 0) {
    issues.push({
      code: 'LOW_CONFIDENCE',
      severity: 'warning',
      message: `Human review required — AI confidence below ${opts.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD} for: ${low.join(', ')}`,
    });
  }
  await repos.invoices.replaceIssues(
    inv.companyId,
    inv.id,
    issues.map((i) => ({
      code: i.code,
      severity: i.severity,
      detail: i.message,
      lineNo: i.lineIndex === undefined ? null : i.lineIndex + 1,
      field: i.field ?? null,
    })),
  );
  const status = transitionInvoice(
    inv.status === 'posted' ? 'posted' : inv.status,
    issues.some((i) => i.severity === 'error') || low.length > 0 ? 'needs_review' : 'validated',
  );
  await repos.invoices.updateHeader(inv.companyId, inv.id, { status });
  return { status, issues };
}
