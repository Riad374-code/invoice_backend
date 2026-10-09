import { D, type TaxRate, type TaxType, type VatTreatment } from '../../accounting/index.js';
import type { Db } from '../client.js';

interface TaxRateRow {
  id: string;
  tax_type: TaxType;
  code: string;
  rate: string;
  treatment: VatTreatment | null;
  valid_from: string;
  valid_to: string | null;
  legal_source_id: string | null;
  status: 'proposed' | 'active';
  [k: string]: unknown;
}

// DATE sütunları ::text ilə oxunur → 'YYYY-MM-DD' (JS Date-in saat qurşağı sürüşməsi olmasın)
const COLS = `id, tax_type, code, rate::text AS rate, treatment, valid_from::text AS valid_from,
  valid_to::text AS valid_to, legal_source_id, status`;

const toRate = (r: TaxRateRow): TaxRate => ({
  id: r.id,
  taxType: r.tax_type,
  code: r.code,
  ratePercent: new D(r.rate),
  validFrom: r.valid_from,
  validTo: r.valid_to,
  legalSourceId: r.legal_source_id,
  status: r.status,
  treatment: r.treatment,
});

export interface TaxRateFilter {
  taxType?: TaxType | undefined;
  /** Yalnız bu tarixdə qüvvədə olanlar. */
  effectiveOn?: string | undefined;
  status?: 'proposed' | 'active' | undefined;
}

export class TaxRateRepository {
  constructor(private readonly db: Db) {}

  async list(filter: TaxRateFilter = {}): Promise<TaxRate[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (filter.taxType) add('tax_type = ?', filter.taxType);
    if (filter.status) add('status = ?', filter.status);
    if (filter.effectiveOn) {
      params.push(filter.effectiveOn);
      where.push(
        `valid_from <= $${params.length}::date AND (valid_to IS NULL OR valid_to >= $${params.length}::date)`,
      );
    }
    const rows = await this.db.query<TaxRateRow>(
      `SELECT ${COLS} FROM tax_rates ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY tax_type, code, valid_from`,
      params,
    );
    return rows.map(toRate);
  }

  /** Mühərrikə verilən sətirlər: yalnız AKTİV dərəcələr (tam tarixçə — dəyişiklik sərhədləri üçün). */
  listActive(taxType?: TaxType): Promise<TaxRate[]> {
    return this.list({ status: 'active', taxType });
  }

  async create(rate: Omit<TaxRate, 'id'> & { id?: string }): Promise<TaxRate> {
    const [row] = await this.db.query<TaxRateRow>(
      `INSERT INTO tax_rates (id, tax_type, code, rate, treatment, valid_from, valid_to, legal_source_id, status)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4::numeric, $5, $6::date, $7::date, $8, $9)
       RETURNING ${COLS}`,
      [
        rate.id ?? null,
        rate.taxType,
        rate.code,
        rate.ratePercent.toString(),
        rate.treatment ?? null,
        rate.validFrom,
        rate.validTo,
        rate.legalSourceId,
        rate.status,
      ],
    );
    return toRate(row!);
  }
}
