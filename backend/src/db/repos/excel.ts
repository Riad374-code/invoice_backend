import { toJson, type Db } from '../client.js';
import type { MatchType } from '../../recon/match.js';

type R = Record<string, unknown>;

export interface ExcelJobRow {
  id: string;
  operation: 'profile' | 'clean' | 'reconcile' | 'report';
  inputFileId: string | null;
  params: unknown;
  outputFileId: string | null;
  status: 'pending' | 'running' | 'done' | 'failed';
  result: unknown;
  error: string | null;
  createdBy: string;
  createdAt: Date;
}
export interface ImportJobRow {
  id: string;
  source: 'etaxes' | '1c' | 'bank';
  templateVersion: string | null;
  fileId: string | null;
  rowsOk: number;
  rowsFailed: number;
  status: string;
  error: string | null;
  preview: unknown;
  approvalId: string | null;
  createdBy: string | null;
  createdAt: Date;
}
export interface MatchRow {
  id: string;
  matchType: MatchType;
  confidence: string;
  leftRef: unknown;
  rightRef: unknown;
  difference: string | null;
  explanation: string;
  status: 'proposed' | 'confirmed';
  confirmedBy: string | null;
  confirmedAt: Date | null;
}

const XJ = `id, operation, input_file_id, params, output_file_id, status, result, error, created_by, created_at`;
const toX = (r: R): ExcelJobRow => ({
  id: r['id'] as string,
  operation: r['operation'] as ExcelJobRow['operation'],
  inputFileId: r['input_file_id'] as string | null,
  params: r['params'],
  outputFileId: r['output_file_id'] as string | null,
  status: r['status'] as ExcelJobRow['status'],
  result: r['result'],
  error: r['error'] as string | null,
  createdBy: r['created_by'] as string,
  createdAt: r['created_at'] as Date,
});
const IJ = `id, source, template_version, file_id, rows_ok, rows_failed, status, error, preview, approval_id, created_by, created_at`;
const toI = (r: R): ImportJobRow => ({
  id: r['id'] as string,
  source: r['source'] as ImportJobRow['source'],
  templateVersion: r['template_version'] as string | null,
  fileId: r['file_id'] as string | null,
  rowsOk: r['rows_ok'] as number,
  rowsFailed: r['rows_failed'] as number,
  status: r['status'] as string,
  error: r['error'] as string | null,
  preview: r['preview'],
  approvalId: r['approval_id'] as string | null,
  createdBy: r['created_by'] as string | null,
  createdAt: r['created_at'] as Date,
});

export class ExcelRepository {
  constructor(private readonly db: Db) {}

  async createJob(j: {
    companyId: string;
    userId: string;
    operation: string;
    inputFileId: string | null;
    params: unknown;
  }): Promise<string> {
    const [r] = await this.db.query<{ id: string }>(
      `INSERT INTO excel_jobs (company_id, created_by, input_file_id, operation, params) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
      [j.companyId, j.userId, j.inputFileId, j.operation, toJson(j.params)],
    );
    return r!.id;
  }
  async getJob(companyId: string, id: string): Promise<ExcelJobRow | null> {
    const [r] = await this.db.query<R>(
      `SELECT ${XJ} FROM excel_jobs WHERE id = $1 AND company_id = $2`,
      [id, companyId],
    );
    return r ? toX(r) : null;
  }
  async setJob(
    id: string,
    p: {
      status: 'running' | 'done' | 'failed';
      outputFileId?: string | null;
      result?: unknown;
      error?: string | null;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE excel_jobs SET status = $2, output_file_id = COALESCE($3, output_file_id), result = COALESCE($4::jsonb, result), error = $5, updated_at = NOW() WHERE id = $1`,
      [
        id,
        p.status,
        p.outputFileId ?? null,
        p.result === undefined ? null : toJson(p.result),
        p.error ?? null,
      ],
    );
  }

  // ---------------------------------------------------------------- import
  async createImport(j: {
    companyId: string;
    userId: string;
    source: string;
    fileId: string | null;
    templateVersion: string;
    rowsOk: number;
    rowsFailed: number;
    preview: unknown;
  }): Promise<string> {
    const [r] = await this.db.query<{ id: string }>(
      `INSERT INTO import_jobs (company_id, source, file_id, template_version, rows_ok, rows_failed, status, preview, created_by) VALUES ($1,$2,$3,$4,$5,$6,'previewed',$7::jsonb,$8) RETURNING id`,
      [
        j.companyId,
        j.source,
        j.fileId,
        j.templateVersion,
        j.rowsOk,
        j.rowsFailed,
        toJson(j.preview),
        j.userId,
      ],
    );
    return r!.id;
  }
  async getImport(
    companyId: string,
    id: string,
    opts: { forUpdate?: boolean } = {},
  ): Promise<ImportJobRow | null> {
    const [r] = await this.db.query<R>(
      `SELECT ${IJ} FROM import_jobs WHERE id = $1 AND company_id = $2 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
      [id, companyId],
    );
    return r ? toI(r) : null;
  }
  async setImport(
    id: string,
    p: {
      status?: string;
      rowsOk?: number;
      rowsFailed?: number;
      approvalId?: string | null;
      clearApproval?: boolean;
      error?: string | null;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE import_jobs SET status = COALESCE($2, status), rows_ok = COALESCE($3, rows_ok), rows_failed = COALESCE($4, rows_failed), approval_id = CASE WHEN $6::boolean THEN NULL ELSE COALESCE($5, approval_id) END, error = COALESCE($7, error), updated_at = NOW() WHERE id = $1`,
      [
        id,
        p.status ?? null,
        p.rowsOk ?? null,
        p.rowsFailed ?? null,
        p.approvalId ?? null,
        p.clearApproval ?? false,
        p.error ?? null,
      ],
    );
  }
  async addBank(
    companyId: string,
    importJobId: string,
    rows: Array<{
      date: string;
      amount: string;
      description: string | null;
      reference: string | null;
      counterpartyVoen: string | null;
    }>,
  ): Promise<number> {
    for (const b of rows)
      await this.db.query(
        `INSERT INTO bank_transactions (company_id, import_job_id, tx_date, amount, description, reference, counterparty_voen) VALUES ($1,$2,$3::date,$4::numeric,$5,$6,$7)`,
        [companyId, importJobId, b.date, b.amount, b.description, b.reference, b.counterpartyVoen],
      );
    return rows.length;
  }
  async bank(
    companyId: string,
    f: { from?: string | undefined; to?: string | undefined },
  ): Promise<
    Array<{
      id: string;
      date: string;
      amount: string;
      description: string | null;
      reference: string | null;
    }>
  > {
    const rows = await this.db.query<R>(
      `SELECT id, tx_date::text AS d, amount::text AS a, description, reference FROM bank_transactions WHERE company_id = $1 AND ($2::date IS NULL OR tx_date >= $2::date) AND ($3::date IS NULL OR tx_date <= $3::date) ORDER BY tx_date, id`,
      [companyId, f.from ?? null, f.to ?? null],
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      date: r['d'] as string,
      amount: r['a'] as string,
      description: r['description'] as string | null,
      reference: r['reference'] as string | null,
    }));
  }

  // -------------------------------------------------------- reconciliation
  async createRecon(x: {
    companyId: string;
    userId: string;
    left: string;
    right: string;
    summary: unknown;
    matches: Array<{
      type: string;
      confidence: string;
      left: unknown;
      right: unknown;
      difference: string | null;
      explanation: string;
    }>;
  }): Promise<string> {
    const [r] = await this.db.query<{ id: string }>(
      `INSERT INTO reconciliations (company_id, created_by, left_source, right_source, summary) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
      [x.companyId, x.userId, x.left, x.right, toJson(x.summary)],
    );
    for (const m of x.matches)
      await this.db.query(
        `INSERT INTO reconciliation_matches (company_id, reconciliation_id, match_type, confidence, left_ref, right_ref, difference, explanation) VALUES ($1,$2,$3,$4::numeric,$5::jsonb,$6::jsonb,$7::numeric,$8)`,
        [
          x.companyId,
          r!.id,
          m.type,
          m.confidence,
          toJson(m.left),
          toJson(m.right),
          m.difference,
          m.explanation,
        ],
      );
    return r!.id;
  }
  async getRecon(
    companyId: string,
    id: string,
  ): Promise<{
    id: string;
    leftSource: string;
    rightSource: string;
    status: string;
    summary: unknown;
    createdAt: Date;
  } | null> {
    const [r] = await this.db.query<R>(
      `SELECT id, left_source, right_source, status, summary, created_at FROM reconciliations WHERE id = $1 AND company_id = $2`,
      [id, companyId],
    );
    return r
      ? {
          id: r['id'] as string,
          leftSource: r['left_source'] as string,
          rightSource: r['right_source'] as string,
          status: r['status'] as string,
          summary: r['summary'],
          createdAt: r['created_at'] as Date,
        }
      : null;
  }
  async matches(companyId: string, reconId: string): Promise<MatchRow[]> {
    const rows = await this.db.query<R>(
      `SELECT id, match_type, confidence::text AS c, left_ref, right_ref, difference::text AS d, explanation, status, confirmed_by, confirmed_at FROM reconciliation_matches WHERE reconciliation_id = $1 AND company_id = $2 ORDER BY confidence DESC, id`,
      [reconId, companyId],
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      matchType: r['match_type'] as MatchType,
      confidence: r['c'] as string,
      leftRef: r['left_ref'],
      rightRef: r['right_ref'],
      difference: r['d'] as string | null,
      explanation: r['explanation'] as string,
      status: r['status'] as MatchRow['status'],
      confirmedBy: r['confirmed_by'] as string | null,
      confirmedAt: r['confirmed_at'] as Date | null,
    }));
  }
  /** Yalnız uyğunlaşdırılmış (cüt) təklif təsdiqlənə bilər; qalıqlar (unmatched) təsdiq obyekti deyil. */
  async confirmMatch(
    companyId: string,
    reconId: string,
    matchId: string,
    userId: string,
    now: Date,
  ): Promise<'confirmed' | 'not_found' | 'not_confirmable' | 'already'> {
    const [m] = await this.db.query<R>(
      `SELECT match_type, status FROM reconciliation_matches WHERE id = $1 AND reconciliation_id = $2 AND company_id = $3 FOR UPDATE`,
      [matchId, reconId, companyId],
    );
    if (!m) return 'not_found';
    if ((m['match_type'] as string).startsWith('unmatched')) return 'not_confirmable';
    if (m['status'] === 'confirmed') return 'already';
    await this.db.query(
      `UPDATE reconciliation_matches SET status = 'confirmed', confirmed_by = $2, confirmed_at = $3 WHERE id = $1`,
      [matchId, userId, now],
    );
    return 'confirmed';
  }
}
