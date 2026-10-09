import type { Repos } from '../db/index.js';
import type { SheetSpec } from '../documents/table.js';

export async function invoiceReportRows(
  repos: Repos,
  companyId: string,
  from: string,
  to: string,
): Promise<SheetSpec> {
  const rows = await repos.invoices.list(companyId, { from, to, limit: 10_000 });
  const cps = new Map<string, { name: string; voen: string | null }>();
  for (const r of rows)
    if (r.counterpartyId && !cps.has(r.counterpartyId)) {
      const c = await repos.invoices.getCounterparty(companyId, r.counterpartyId);
      if (c) cps.set(c.id, c);
    }
  return {
    name: 'Invoices',
    headers: [
      'Date',
      'Direction',
      'Number',
      'Counterparty',
      'VOEN',
      'Currency',
      'Net',
      'VAT',
      'Gross',
      'Status',
    ],
    rows: rows.map((i) => [
      i.issueDate,
      i.direction,
      i.number,
      cps.get(i.counterpartyId ?? '')?.name ?? '',
      cps.get(i.counterpartyId ?? '')?.voen ?? '',
      i.currency,
      i.net,
      i.vat,
      i.gross,
      i.status,
    ]),
  };
}

export async function journalReportRows(
  repos: Repos,
  companyId: string,
  from: string,
  to: string,
): Promise<SheetSpec> {
  const entries = await repos.ledger.list(companyId, { from, to, limit: 10_000 });
  const rows: SheetSpec['rows'] = [];
  for (const e of entries)
    for (const l of await repos.ledger.lines(companyId, e.id))
      rows.push([e.entryDate, e.status, e.description, l.accountCode, l.debit, l.credit]);
  return {
    name: 'Journal',
    headers: ['Date', 'Status', 'Description', 'Account', 'Debit', 'Credit'],
    rows,
  };
}
