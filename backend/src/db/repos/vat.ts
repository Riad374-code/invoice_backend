import type { Db } from '../client.js';

type R = Record<string, unknown>;

export interface ReturnRow {
  id: string;
  periodId: string;
  period: string;
  version: number;
  outputVat: string;
  inputVat: string;
  exemptTurnover: string;
  zeroRatedTurnover: string;
  payable: string;
  depositBalance: string | null;
  status: 'draft' | 'submitted';
  draftFileId: string | null;
  summary: unknown;
  createdAt: Date;
}
const RET = `r.id, r.period_id, p.period, r.version, r.output_vat::text AS output_vat, r.input_vat::text AS input_vat, r.exempt_turnover::text AS exempt_turnover,
  r.zero_rated_turnover::text AS zero_rated_turnover, r.payable::text AS payable, r.deposit_balance::text AS deposit_balance, r.status, r.draft_file_id, r.summary, r.created_at`;
const toReturn = (r: R): ReturnRow => ({
  id: r['id'] as string,
  periodId: r['period_id'] as string,
  period: (r['period'] as string).trim(),
  version: r['version'] as number,
  outputVat: r['output_vat'] as string,
  inputVat: r['input_vat'] as string,
  exemptTurnover: r['exempt_turnover'] as string,
  zeroRatedTurnover: r['zero_rated_turnover'] as string,
  payable: r['payable'] as string,
  depositBalance: r['deposit_balance'] as string | null,
  status: r['status'] as ReturnRow['status'],
  draftFileId: r['draft_file_id'] as string | null,
  summary: r['summary'],
  createdAt: r['created_at'] as Date,
});

export class VatRepository {
  constructor(private readonly db: Db) {}

  async ensurePeriod(companyId: string, period: string): Promise<{ id: string; status: string }> {
    const [r] = await this.db.query<R>(
      `INSERT INTO vat_periods (company_id, period) VALUES ($1,$2) ON CONFLICT (company_id, period) DO UPDATE SET period = EXCLUDED.period RETURNING id, status`,
      [companyId, period],
    );
    return { id: r!['id'] as string, status: r!['status'] as string };
  }
  async listPeriods(
    companyId: string,
  ): Promise<Array<{ period: string; status: string; latestVersion: number | null }>> {
    const rows = await this.db.query<R>(
      `SELECT p.period, p.status, (SELECT max(version) FROM vat_returns r WHERE r.period_id = p.id) AS v FROM vat_periods p WHERE p.company_id = $1 ORDER BY p.period DESC`,
      [companyId],
    );
    return rows.map((r) => ({
      period: (r['period'] as string).trim(),
      status: r['status'] as string,
      latestVersion: r['v'] as number | null,
    }));
  }
  async setPeriodStatus(periodId: string, status: 'open' | 'draft' | 'filed'): Promise<void> {
    await this.db.query(`UPDATE vat_periods SET status = $2 WHERE id = $1`, [periodId, status]);
  }
  async addReturn(x: {
    companyId: string;
    periodId: string;
    outputVat: string;
    inputVat: string;
    exemptTurnover: string;
    zeroRatedTurnover: string;
    payable: string;
    depositBalance: string | null;
    draftFileId: string | null;
    summary: unknown;
    createdBy: string;
  }): Promise<string> {
    const [r] = await this.db.query<{ id: string }>(
      `INSERT INTO vat_returns (company_id, period_id, version, output_vat, input_vat, exempt_turnover, zero_rated_turnover, payable, deposit_balance, draft_file_id, summary, created_by)
       VALUES ($1,$2,(SELECT COALESCE(max(version),0)+1 FROM vat_returns WHERE period_id = $2),$3::numeric,$4::numeric,$5::numeric,$6::numeric,$7::numeric,$8::numeric,$9,$10::jsonb,$11) RETURNING id`,
      [
        x.companyId,
        x.periodId,
        x.outputVat,
        x.inputVat,
        x.exemptTurnover,
        x.zeroRatedTurnover,
        x.payable,
        x.depositBalance,
        x.draftFileId,
        JSON.stringify(x.summary),
        x.createdBy,
      ],
    );
    return r!.id;
  }
  async latestReturn(companyId: string, period: string): Promise<ReturnRow | null> {
    const [r] = await this.db.query<R>(
      `SELECT ${RET} FROM vat_returns r JOIN vat_periods p ON p.id = r.period_id WHERE r.company_id = $1 AND p.period = $2 ORDER BY r.version DESC LIMIT 1`,
      [companyId, period],
    );
    return r ? toReturn(r) : null;
  }

  // ---------------------------------------------------------------- deposit
  async importDeposit(
    companyId: string,
    userId: string,
    period: string,
    lines: Array<{
      date: string;
      operation: string;
      amount: string;
      reference?: string | null | undefined;
      counterpartyVoen?: string | null | undefined;
    }>,
  ): Promise<string> {
    const [s] = await this.db.query<{ id: string }>(
      `INSERT INTO vat_deposit_statements (company_id, period, imported_by) VALUES ($1,$2,$3) RETURNING id`,
      [companyId, period, userId],
    );
    for (const l of lines) {
      await this.db.query(
        `INSERT INTO vat_deposit_lines (company_id, statement_id, line_date, operation, amount, reference, counterparty_voen) VALUES ($1,$2,$3::date,$4,$5::numeric,$6,$7)`,
        [
          companyId,
          s!.id,
          l.date,
          l.operation,
          l.amount,
          l.reference ?? null,
          l.counterpartyVoen ?? null,
        ],
      );
    }
    return s!.id;
  }
  /** Depozit qalığı = doldurma + geri qaytarma − ƏDV ödənişi − çıxarış (son tarixə qədər, bütün idxallar). */
  async depositBalance(
    companyId: string,
    upTo: string,
  ): Promise<{ balance: string; lines: number }> {
    const [r] = await this.db.query<R>(
      `SELECT COALESCE(SUM(CASE WHEN operation IN ('top_up','refund') THEN amount WHEN operation IN ('vat_payment','withdrawal') THEN -amount ELSE 0 END), 0)::text AS b, count(*)::int AS n
         FROM vat_deposit_lines WHERE company_id = $1 AND line_date <= $2::date`,
      [companyId, upTo],
    );
    return { balance: r!['b'] as string, lines: r!['n'] as number };
  }

  // ----------------------------------------------------------------- calendar
  async calendar(f: {
    from?: string | undefined;
    to?: string | undefined;
    taxType?: string | undefined;
  }): Promise<
    Array<{ taxType: string; period: string; dueDate: string; legalSourceId: string | null }>
  > {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.from) add('due_date >= ?::date', f.from);
    if (f.to) add('due_date <= ?::date', f.to);
    if (f.taxType) add('tax_type = ?', f.taxType);
    const rows = await this.db.query<R>(
      `SELECT tax_type, period, due_date::text AS due_date, legal_source_id FROM tax_calendar ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY due_date, tax_type`,
      params,
    );
    return rows.map((r) => ({
      taxType: r['tax_type'] as string,
      period: r['period'] as string,
      dueDate: r['due_date'] as string,
      legalSourceId: r['legal_source_id'] as string | null,
    }));
  }

  // ---------------------------------------------------------------- fx rates
  async upsertFx(
    rows: Array<{ currency: string; date: string; rate: string; nominal: number }>,
    source = 'CBAR',
  ): Promise<number> {
    for (const r of rows) {
      await this.db.query(
        `INSERT INTO fx_rates (currency, date, rate, nominal, source) VALUES ($1,$2::date,$3::numeric,$4,$5) ON CONFLICT (currency, date, source) DO UPDATE SET rate = EXCLUDED.rate, nominal = EXCLUDED.nominal`,
        [r.currency, r.date, r.rate, r.nominal, source],
      );
    }
    return rows.length;
  }
}
