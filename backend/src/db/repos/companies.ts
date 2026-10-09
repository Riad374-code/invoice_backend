import type { Company, ReportingStandard, TaxRegime } from '../../domain/index.js';
import type { Db } from '../client.js';

interface CompanyRow {
  id: string;
  name: string;
  voen: string;
  base_currency: string;
  is_vat_payer: boolean;
  tax_regime: TaxRegime;
  reporting_standard: ReportingStandard;
  chart_of_accounts_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  [k: string]: unknown;
}

const COLUMNS = `id, name, voen, base_currency, is_vat_payer, tax_regime, reporting_standard,
  chart_of_accounts_id, created_at, updated_at, deleted_at`;

const toCompany = (r: CompanyRow): Company => ({
  id: r.id,
  name: r.name,
  voen: r.voen,
  baseCurrency: r.base_currency,
  isVatPayer: r.is_vat_payer,
  taxRegime: r.tax_regime,
  reportingStandard: r.reporting_standard,
  chartOfAccountsId: r.chart_of_accounts_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});

export class CompanyRepository {
  constructor(private readonly db: Db) {}

  async create(c: Company): Promise<Company> {
    await this.db.query(
      `INSERT INTO companies (id, name, voen, base_currency, is_vat_payer, tax_regime,
         reporting_standard, chart_of_accounts_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        c.id,
        c.name,
        c.voen,
        c.baseCurrency,
        c.isVatPayer,
        c.taxRegime,
        c.reportingStandard,
        c.chartOfAccountsId,
        c.createdAt,
        c.updatedAt,
      ],
    );
    return c;
  }

  async findById(id: string): Promise<Company | null> {
    const [row] = await this.db.query<CompanyRow>(
      `SELECT ${COLUMNS} FROM companies WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return row ? toCompany(row) : null;
  }

  async findByVoen(voen: string): Promise<Company | null> {
    const [row] = await this.db.query<CompanyRow>(
      `SELECT ${COLUMNS} FROM companies WHERE voen = $1 AND deleted_at IS NULL`,
      [voen],
    );
    return row ? toCompany(row) : null;
  }
}
