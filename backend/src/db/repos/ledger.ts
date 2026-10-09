import type { Db } from '../client.js';

type R = Record<string, unknown>;
export type EntryStatus = 'proposed' | 'approved' | 'posted';

export interface EntryRow {
  id: string;
  entryDate: string;
  description: string;
  status: EntryStatus;
  source: 'invoice' | 'manual' | 'ai';
  sourceInvoiceId: string | null;
  createdBy: string;
  approvalId: string | null;
  approvedBy: string | null;
  postedAt: Date | null;
  createdAt: Date;
}
export interface JLine {
  lineNo: number;
  accountCode: string;
  accountId: string | null;
  debit: string;
  credit: string;
  description: string | null;
}
export interface AccountRow {
  id: string;
  code: string;
  nameAz: string;
  nameRu: string | null;
  nameEn: string | null;
  type: string;
  parentId: string | null;
}

const COLS = `id, entry_date::text AS entry_date, description, status, source, source_invoice_id, created_by, approval_id, approved_by, posted_at, created_at`;
const toEntry = (r: R): EntryRow => ({
  id: r['id'] as string,
  entryDate: r['entry_date'] as string,
  description: r['description'] as string,
  status: r['status'] as EntryStatus,
  source: r['source'] as EntryRow['source'],
  sourceInvoiceId: r['source_invoice_id'] as string | null,
  createdBy: r['created_by'] as string,
  approvalId: r['approval_id'] as string | null,
  approvedBy: r['approved_by'] as string | null,
  postedAt: r['posted_at'] as Date | null,
  createdAt: r['created_at'] as Date,
});

export class LedgerRepository {
  constructor(private readonly db: Db) {}

  async createEntry(e: {
    companyId: string;
    entryDate: string;
    description: string;
    source: EntryRow['source'];
    sourceInvoiceId: string | null;
    createdBy: string;
    lines: Array<{
      accountCode: string;
      accountId?: string | null;
      debit: string;
      credit: string;
      description?: string | null;
    }>;
  }): Promise<string> {
    const [row] = await this.db.query<{ id: string }>(
      `INSERT INTO journal_entries (company_id, entry_date, description, source, source_invoice_id, created_by) VALUES ($1,$2::date,$3,$4,$5,$6) RETURNING id`,
      [e.companyId, e.entryDate, e.description, e.source, e.sourceInvoiceId, e.createdBy],
    );
    let n = 1;
    for (const l of e.lines) {
      await this.db.query(
        `INSERT INTO journal_lines (company_id, entry_id, line_no, account_code, account_id, debit, credit, description) VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8)`,
        [
          e.companyId,
          row!.id,
          n++,
          l.accountCode,
          l.accountId ?? null,
          l.debit,
          l.credit,
          l.description ?? null,
        ],
      );
    }
    return row!.id;
  }

  async find(
    companyId: string,
    id: string,
    opts: { forUpdate?: boolean } = {},
  ): Promise<EntryRow | null> {
    const [r] = await this.db.query<R>(
      `SELECT ${COLS} FROM journal_entries WHERE id = $1 AND company_id = $2 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [id, companyId],
    );
    return r ? toEntry(r) : null;
  }
  async lines(companyId: string, entryId: string): Promise<JLine[]> {
    const rows = await this.db.query<R>(
      `SELECT line_no, account_code, account_id, debit::text AS debit, credit::text AS credit, description FROM journal_lines WHERE entry_id = $1 AND company_id = $2 ORDER BY line_no`,
      [entryId, companyId],
    );
    return rows.map((r) => ({
      lineNo: r['line_no'] as number,
      accountCode: r['account_code'] as string,
      accountId: r['account_id'] as string | null,
      debit: r['debit'] as string,
      credit: r['credit'] as string,
      description: r['description'] as string | null,
    }));
  }
  async list(
    companyId: string,
    f: {
      status?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      limit: number;
      cursor?: { date: string; id: string } | undefined;
    },
  ): Promise<EntryRow[]> {
    const where = ['company_id = $1'];
    const params: unknown[] = [companyId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.status) add('status = ?', f.status);
    if (f.from) add('entry_date >= ?::date', f.from);
    if (f.to) add('entry_date <= ?::date', f.to);
    if (f.cursor) {
      params.push(f.cursor.date, f.cursor.id);
      where.push(`(entry_date, id) < ($${params.length - 1}::date, $${params.length}::uuid)`);
    }
    params.push(f.limit + 1);
    const rows = await this.db.query<R>(
      `SELECT ${COLS} FROM journal_entries WHERE ${where.join(' AND ')} ORDER BY entry_date DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toEntry);
  }
  /** Qaimə üçün açıq (hələ təsdiqlənməmiş) təklif — yenidən təklif köhnəsini əvəz edir. */
  async deleteOpenProposalForInvoice(companyId: string, invoiceId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM journal_entries WHERE company_id = $1 AND source_invoice_id = $2 AND status = 'proposed' AND approval_id IS NULL`,
      [companyId, invoiceId],
    );
  }
  async openProposalForInvoice(companyId: string, invoiceId: string): Promise<EntryRow | null> {
    const [r] = await this.db.query<R>(
      `SELECT ${COLS} FROM journal_entries WHERE company_id = $1 AND source_invoice_id = $2 AND status = 'proposed' ORDER BY created_at DESC LIMIT 1`,
      [companyId, invoiceId],
    );
    return r ? toEntry(r) : null;
  }
  async setApproval(companyId: string, id: string, approvalId: string | null): Promise<void> {
    await this.db.query(
      `UPDATE journal_entries SET approval_id = $3, updated_at = NOW() WHERE id = $1 AND company_id = $2`,
      [id, companyId, approvalId],
    );
  }
  /** proposed → approved → posted (DB trigger balansı və dəyişməzliyi yoxlayır). */
  async approveAndPost(
    companyId: string,
    id: string,
    approvedBy: string,
    now: Date,
  ): Promise<void> {
    await this.db.query(
      `UPDATE journal_entries SET status = 'approved', approved_by = $3, updated_at = $4 WHERE id = $1 AND company_id = $2 AND status = 'proposed'`,
      [id, companyId, approvedBy, now],
    );
    await this.db.query(
      `UPDATE journal_entries SET status = 'posted', posted_at = $3, updated_at = $3 WHERE id = $1 AND company_id = $2 AND status = 'approved'`,
      [id, companyId, now],
    );
  }
  async linkLineAccounts(
    companyId: string,
    entryId: string,
    codes: ReadonlyMap<string, string>,
  ): Promise<void> {
    for (const [code, accountId] of codes) {
      await this.db.query(
        `UPDATE journal_lines SET account_id = $4 WHERE entry_id = $1 AND company_id = $2 AND account_code = $3`,
        [entryId, companyId, code, accountId],
      );
    }
  }

  // ------------------------------------------------------------ chart
  async listAccounts(companyId: string): Promise<AccountRow[]> {
    const rows = await this.db.query<R>(
      `SELECT a.id, a.code, a.name_az, a.name_ru, a.name_en, a.type, a.parent_id FROM accounts a JOIN companies c ON c.chart_of_accounts_id = a.chart_id WHERE c.id = $1 AND a.company_id = $1 ORDER BY a.code`,
      [companyId],
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      code: r['code'] as string,
      nameAz: r['name_az'] as string,
      nameRu: r['name_ru'] as string | null,
      nameEn: r['name_en'] as string | null,
      type: r['type'] as string,
      parentId: r['parent_id'] as string | null,
    }));
  }
  async importChart(
    companyId: string,
    name: string,
    standard: 'MMUS' | 'MHBS',
    accounts: Array<{
      code: string;
      nameAz: string;
      nameRu?: string | undefined;
      nameEn?: string | undefined;
      type: string;
      parentCode?: string | undefined;
    }>,
  ): Promise<string> {
    const [chart] = await this.db.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (company_id, name, standard) VALUES ($1,$2,$3) RETURNING id`,
      [companyId, name, standard],
    );
    const ids = new Map<string, string>();
    for (const a of accounts) {
      const parent = a.parentCode ? (ids.get(a.parentCode) ?? null) : null;
      const [r] = await this.db.query<{ id: string }>(
        `INSERT INTO accounts (company_id, chart_id, code, name_az, name_ru, name_en, type, parent_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          companyId,
          chart!.id,
          a.code,
          a.nameAz,
          a.nameRu ?? null,
          a.nameEn ?? null,
          a.type,
          parent,
        ],
      );
      ids.set(a.code, r!.id);
    }
    await this.db.query(
      `UPDATE companies SET chart_of_accounts_id = $2, updated_at = NOW() WHERE id = $1`,
      [companyId, chart!.id],
    );
    return chart!.id;
  }
}
