import { D, assertLocalDate } from '../accounting/index.js';
import type { Repos } from '../db/index.js';
import { normalizeAmount, normalizeDate } from '../documents/excel-ops.js';
import { readTable, type Table } from '../documents/table.js';
import { DomainError } from '../domain/index.js';
import type { ObjectStorage } from '../storage/index.js';
import { normKey, reconcileItems, type ReconItem, type ReconMatch } from './match.js';

export type SourceSpec =
  | {
      type: 'file';
      fileId: string;
      keyColumn: string;
      amountColumn: string;
      dateColumn?: string | undefined;
    }
  | { type: 'invoices'; from: string; to: string; direction?: 'sales' | 'purchase' | undefined }
  | { type: 'bank'; from?: string | undefined; to?: string | undefined };

export async function loadTable(
  deps: { repos: Repos; storage: ObjectStorage },
  companyId: string,
  fileId: string,
): Promise<Table> {
  const file = await deps.repos.files.findById(companyId, fileId);
  const version = file && (await deps.repos.files.latestVersion(companyId, file.id));
  if (!file || !version) throw new DomainError('NOT_FOUND', `File ${fileId} not found`);
  const kind =
    version.mime === 'text/csv'
      ? 'csv'
      : version.mime.includes('spreadsheet') || version.mime === 'application/vnd.ms-excel'
        ? 'xlsx'
        : null;
  if (!kind) throw new DomainError('VALIDATION', `File ${file.name} is not a spreadsheet or CSV`);
  return readTable(await deps.storage.get(version.storageKey), kind);
}

function col(t: Table, name: string): number {
  const i = t.headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  if (i === -1)
    throw new DomainError(
      'VALIDATION',
      `Column "${name}" not found (have: ${t.headers.join(', ')})`,
    );
  return i;
}

export interface LoadedSide {
  label: string;
  items: ReconItem[];
  /** Oxunmayan sətirlər (rəqəm tanınmadı) — səssizcə atılmır, hesabata düşür */
  skipped: Array<{ ref: string; reason: string }>;
}

export async function loadSide(
  deps: { repos: Repos; storage: ObjectStorage },
  companyId: string,
  spec: SourceSpec,
): Promise<LoadedSide> {
  if (spec.type === 'file') {
    const t = await loadTable(deps, companyId, spec.fileId);
    const [ki, ai] = [col(t, spec.keyColumn), col(t, spec.amountColumn)];
    const di = spec.dateColumn ? col(t, spec.dateColumn) : -1;
    const items: ReconItem[] = [];
    const skipped: LoadedSide['skipped'] = [];
    t.rows.forEach((r, i) => {
      if (r.every((c) => c === '')) return;
      const amount = normalizeAmount(r[ai] ?? '');
      if (amount === null)
        return void skipped.push({
          ref: `row ${i + 2}`,
          reason: `invalid amount "${r[ai] ?? ''}"`,
        });
      items.push({
        ref: `row ${i + 2}`,
        key: normKey(r[ki] ?? ''),
        amount: new D(amount),
        date: di === -1 ? null : normalizeDate(r[di] ?? ''),
      });
    });
    return { label: `file:${spec.fileId}`, items, skipped };
  }
  if (spec.type === 'invoices') {
    assertLocalDate(spec.from);
    assertLocalDate(spec.to);
    const rows = await deps.repos.invoices.list(companyId, {
      from: spec.from,
      to: spec.to,
      direction: spec.direction,
      limit: 10_000,
    });
    return {
      label: `invoices:${spec.from}..${spec.to}`,
      skipped: [],
      items: rows.map((i) => ({
        ref: `invoice:${i.id}`,
        key: normKey(i.number),
        amount: i.direction === 'purchase' ? new D(i.gross).negated() : new D(i.gross),
        date: i.issueDate,
      })),
    };
  }
  const bank = await deps.repos.excel.bank(companyId, { from: spec.from, to: spec.to });
  return {
    label: 'bank',
    skipped: [],
    items: bank.map((b) => ({
      ref: `bank:${b.id}`,
      key: normKey(b.reference ?? ''),
      amount: new D(b.amount),
      date: b.date,
    })),
  };
}

export interface ReconOutcome {
  left: string;
  right: string;
  matches: ReconMatch[];
  summary: {
    exact: number;
    amountMismatch: number;
    amountDate: number;
    unmatchedLeft: number;
    unmatchedRight: number;
    skipped: number;
    leftTotal: string;
    rightTotal: string;
  };
  skipped: LoadedSide['skipped'];
}

export async function runReconciliation(
  deps: { repos: Repos; storage: ObjectStorage },
  companyId: string,
  left: SourceSpec,
  right: SourceSpec,
): Promise<ReconOutcome> {
  const [l, r] = [await loadSide(deps, companyId, left), await loadSide(deps, companyId, right)];
  const matches = reconcileItems(l.items, r.items);
  const count = (t: string) => matches.filter((m) => m.type === t).length;
  const total = (xs: ReconItem[]) => xs.reduce((a, x) => a.plus(x.amount), new D(0)).toFixed(2);
  return {
    left: l.label,
    right: r.label,
    matches,
    skipped: [...l.skipped, ...r.skipped],
    summary: {
      exact: count('exact'),
      amountMismatch: count('amount_mismatch'),
      amountDate: count('amount_date'),
      unmatchedLeft: count('unmatched_left'),
      unmatchedRight: count('unmatched_right'),
      skipped: l.skipped.length + r.skipped.length,
      leftTotal: total(l.items),
      rightTotal: total(r.items),
    },
  };
}

export const refJson = (i: ReconItem | null) =>
  i ? { ref: i.ref, key: i.key, amount: i.amount.toFixed(2), date: i.date } : null;
