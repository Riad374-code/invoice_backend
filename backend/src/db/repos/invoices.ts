import { randomUUID } from 'node:crypto';
import type { Db } from '../client.js';

export type InvoiceStatus = 'extracted' | 'needs_review' | 'validated' | 'posted';
export const INVOICE_STATUSES = ['extracted', 'needs_review', 'validated', 'posted'] as const;

export interface InvoiceRow {
  id: string;
  companyId: string;
  direction: 'sales' | 'purchase';
  number: string;
  issueDate: string;
  counterpartyId: string | null;
  currency: string;
  net: string;
  vat: string;
  gross: string;
  status: InvoiceStatus;
  sourceFileId: string | null;
  extractionConfidence: string | null;
  templateVersion: string | null;
  fieldConfidence: Record<string, number>;
  aiModelVersion: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface LineRow {
  id: string;
  lineNo: number;
  description: string;
  qty: string;
  unitPrice: string;
  vatRateCode: string;
  net: string;
  vat: string;
  accountSuggestion: string | null;
  accountFinal: string | null;
  accountSuggestionConfidence: string | null;
}
export interface IssueRow {
  id: string;
  code: string;
  severity: 'error' | 'warning';
  detail: string;
  lineNo: number | null;
  field: string | null;
}
export interface CounterpartyRow {
  id: string;
  name: string;
  voen: string | null;
  country: string;
  isVatPayer: boolean | null;
}

const INV = `id, company_id, direction, number, issue_date::text AS issue_date, counterparty_id, currency,
  net::text AS net, vat::text AS vat, gross::text AS gross, status, source_file_id,
  extraction_confidence::text AS extraction_confidence, template_version, field_confidence, ai_model_version, created_at, updated_at`;

type R = Record<string, unknown>;
const toInvoice = (r: R): InvoiceRow => ({
  id: r['id'] as string,
  companyId: r['company_id'] as string,
  direction: r['direction'] as InvoiceRow['direction'],
  number: r['number'] as string,
  issueDate: r['issue_date'] as string,
  counterpartyId: r['counterparty_id'] as string | null,
  currency: (r['currency'] as string).trim(),
  net: r['net'] as string,
  vat: r['vat'] as string,
  gross: r['gross'] as string,
  status: r['status'] as InvoiceStatus,
  sourceFileId: r['source_file_id'] as string | null,
  extractionConfidence: r['extraction_confidence'] as string | null,
  templateVersion: r['template_version'] as string | null,
  fieldConfidence: (r['field_confidence'] ?? {}) as Record<string, number>,
  aiModelVersion: r['ai_model_version'] as string | null,
  createdAt: r['created_at'] as Date,
  updatedAt: r['updated_at'] as Date,
});

export interface NewInvoice {
  companyId: string;
  direction: 'sales' | 'purchase';
  number: string;
  issueDate: string;
  counterpartyId: string | null;
  currency: string;
  net: string;
  vat: string;
  gross: string;
  status: InvoiceStatus;
  sourceFileId: string | null;
  extractionConfidence: string | null;
  templateVersion: string | null;
  fieldConfidence?: Record<string, number>;
  aiModelVersion?: string | null;
  lines: Array<
    Omit<
      LineRow,
      'id' | 'lineNo' | 'accountSuggestion' | 'accountFinal' | 'accountSuggestionConfidence'
    >
  >;
}

export class InvoiceRepository {
  constructor(private readonly db: Db) {}

  async upsertCounterparty(
    companyId: string,
    p: { name: string; voen: string | null; isVatPayer: boolean | null },
  ): Promise<string> {
    if (p.voen) {
      const [row] = await this.db.query<{ id: string }>(
        `INSERT INTO counterparties (company_id, name, voen, is_vat_payer) VALUES ($1,$2,$3,$4)
         ON CONFLICT (company_id, voen) WHERE voen IS NOT NULL AND deleted_at IS NULL
         DO UPDATE SET name = EXCLUDED.name, is_vat_payer = COALESCE(EXCLUDED.is_vat_payer, counterparties.is_vat_payer), updated_at = NOW()
         RETURNING id`,
        [companyId, p.name, p.voen, p.isVatPayer],
      );
      return row!.id;
    }
    const [row] = await this.db.query<{ id: string }>(
      `INSERT INTO counterparties (company_id, name, is_vat_payer) VALUES ($1,$2,$3) RETURNING id`,
      [companyId, p.name, p.isVatPayer],
    );
    return row!.id;
  }

  async getCounterparty(companyId: string, id: string): Promise<CounterpartyRow | null> {
    const [r] = await this.db.query<R>(
      `SELECT id, name, voen, country, is_vat_payer FROM counterparties WHERE id = $1 AND company_id = $2`,
      [id, companyId],
    );
    return r
      ? {
          id: r['id'] as string,
          name: r['name'] as string,
          voen: r['voen'] as string | null,
          country: r['country'] as string,
          isVatPayer: r['is_vat_payer'] as boolean | null,
        }
      : null;
  }

  async create(inv: NewInvoice): Promise<string> {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO invoices (id, company_id, direction, number, issue_date, counterparty_id, currency, net, vat, gross,
         status, source_file_id, extraction_confidence, template_version, field_confidence, ai_model_version)
       VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8::numeric,$9::numeric,$10::numeric,$11,$12,$13::numeric,$14,$15::jsonb,$16)`,
      [
        id,
        inv.companyId,
        inv.direction,
        inv.number,
        inv.issueDate,
        inv.counterpartyId,
        inv.currency,
        inv.net,
        inv.vat,
        inv.gross,
        inv.status,
        inv.sourceFileId,
        inv.extractionConfidence,
        inv.templateVersion,
        JSON.stringify(inv.fieldConfidence ?? {}),
        inv.aiModelVersion ?? null,
      ],
    );
    await this.replaceLines(inv.companyId, id, inv.lines);
    return id;
  }

  async replaceLines(
    companyId: string,
    invoiceId: string,
    lines: NewInvoice['lines'],
  ): Promise<void> {
    await this.db.query(`DELETE FROM invoice_lines WHERE invoice_id = $1 AND company_id = $2`, [
      invoiceId,
      companyId,
    ]);
    let n = 1;
    for (const l of lines) {
      await this.db.query(
        `INSERT INTO invoice_lines (company_id, invoice_id, line_no, description, qty, unit_price, vat_rate_code, net, vat)
         VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8::numeric,$9::numeric)`,
        [companyId, invoiceId, n++, l.description, l.qty, l.unitPrice, l.vatRateCode, l.net, l.vat],
      );
    }
  }

  async find(companyId: string, id: string): Promise<InvoiceRow | null> {
    const [r] = await this.db.query<R>(
      `SELECT ${INV} FROM invoices WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [id, companyId],
    );
    return r ? toInvoice(r) : null;
  }

  async lock(companyId: string, id: string): Promise<InvoiceRow | null> {
    const [r] = await this.db.query<R>(
      `SELECT ${INV} FROM invoices WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [id, companyId],
    );
    return r ? toInvoice(r) : null;
  }

  async lines(companyId: string, invoiceId: string): Promise<LineRow[]> {
    const rows = await this.db.query<R>(
      `SELECT id, line_no, description, qty::text AS qty, unit_price::text AS unit_price, vat_rate_code,
              net::text AS net, vat::text AS vat, account_suggestion, account_final,
              account_suggestion_confidence::text AS account_suggestion_confidence
         FROM invoice_lines WHERE invoice_id = $1 AND company_id = $2 ORDER BY line_no`,
      [invoiceId, companyId],
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      lineNo: r['line_no'] as number,
      description: r['description'] as string,
      qty: r['qty'] as string,
      unitPrice: r['unit_price'] as string,
      vatRateCode: r['vat_rate_code'] as string,
      net: r['net'] as string,
      vat: r['vat'] as string,
      accountSuggestion: r['account_suggestion'] as string | null,
      accountFinal: r['account_final'] as string | null,
      accountSuggestionConfidence: r['account_suggestion_confidence'] as string | null,
    }));
  }

  async setLineSuggestion(
    companyId: string,
    lineId: string,
    code: string,
    confidence: number,
    model: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE invoice_lines SET account_suggestion = $3, account_suggestion_confidence = $4::numeric, ai_model_version = $5, updated_at = NOW() WHERE id = $1 AND company_id = $2`,
      [lineId, companyId, code, confidence.toFixed(3), model],
    );
  }

  async updateLine(
    companyId: string,
    lineId: string,
    p: {
      description?: string;
      qty?: string;
      unitPrice?: string;
      vatRateCode?: string;
      net?: string;
      vat?: string;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE invoice_lines SET description = COALESCE($3, description), qty = COALESCE($4::numeric, qty), unit_price = COALESCE($5::numeric, unit_price),
              vat_rate_code = COALESCE($6, vat_rate_code), net = COALESCE($7::numeric, net), vat = COALESCE($8::numeric, vat), updated_at = NOW()
        WHERE id = $1 AND company_id = $2`,
      [
        lineId,
        companyId,
        p.description ?? null,
        p.qty ?? null,
        p.unitPrice ?? null,
        p.vatRateCode ?? null,
        p.net ?? null,
        p.vat ?? null,
      ],
    );
  }

  async setFieldConfidence(
    companyId: string,
    id: string,
    fc: Record<string, number>,
  ): Promise<void> {
    await this.db.query(
      `UPDATE invoices SET field_confidence = $3::jsonb, updated_at = NOW() WHERE id = $1 AND company_id = $2`,
      [id, companyId, JSON.stringify(fc)],
    );
  }

  async chartCodes(companyId: string): Promise<Array<{ code: string; name: string }> | null> {
    const rows = await this.db.query<R>(
      `SELECT a.code, a.name_az FROM accounts a JOIN companies c ON c.chart_of_accounts_id = a.chart_id WHERE c.id = $1 AND a.company_id = $1 ORDER BY a.code`,
      [companyId],
    );
    return rows.length
      ? rows.map((r) => ({ code: r['code'] as string, name: r['name_az'] as string }))
      : null;
  }

  async updateHeader(
    companyId: string,
    id: string,
    p: {
      number?: string;
      issueDate?: string;
      currency?: string;
      net?: string;
      vat?: string;
      gross?: string;
      status?: InvoiceStatus;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE invoices SET number = COALESCE($3, number), issue_date = COALESCE($4::date, issue_date),
              currency = COALESCE($5, currency), net = COALESCE($6::numeric, net), vat = COALESCE($7::numeric, vat),
              gross = COALESCE($8::numeric, gross), status = COALESCE($9, status), updated_at = NOW()
        WHERE id = $1 AND company_id = $2`,
      [
        id,
        companyId,
        p.number ?? null,
        p.issueDate ?? null,
        p.currency ?? null,
        p.net ?? null,
        p.vat ?? null,
        p.gross ?? null,
        p.status ?? null,
      ],
    );
  }

  async setLineAccount(
    companyId: string,
    lineId: string,
    accountFinal: string | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE invoice_lines SET account_final = $3, updated_at = NOW() WHERE id = $1 AND company_id = $2`,
      [lineId, companyId, accountFinal],
    );
  }

  async replaceIssues(
    companyId: string,
    invoiceId: string,
    issues: Array<{
      code: string;
      severity: string;
      detail: string;
      lineNo: number | null;
      field: string | null;
    }>,
  ): Promise<void> {
    await this.db.query(`DELETE FROM invoice_issues WHERE invoice_id = $1 AND company_id = $2`, [
      invoiceId,
      companyId,
    ]);
    for (const i of issues) {
      await this.db.query(
        `INSERT INTO invoice_issues (company_id, invoice_id, code, severity, detail, line_no, field) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [companyId, invoiceId, i.code, i.severity, i.detail, i.lineNo, i.field],
      );
    }
  }

  async issues(companyId: string, invoiceId: string): Promise<IssueRow[]> {
    const rows = await this.db.query<R>(
      `SELECT id, code, severity, detail, line_no, field FROM invoice_issues WHERE invoice_id = $1 AND company_id = $2 ORDER BY created_at, id`,
      [invoiceId, companyId],
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      code: r['code'] as string,
      severity: r['severity'] as 'error' | 'warning',
      detail: r['detail'] as string,
      lineNo: r['line_no'] as number | null,
      field: r['field'] as string | null,
    }));
  }

  async list(
    companyId: string,
    f: {
      direction?: string | undefined;
      status?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      limit: number;
      cursor?: { issueDate: string; id: string } | undefined;
    },
  ): Promise<InvoiceRow[]> {
    const where = ['company_id = $1', 'deleted_at IS NULL'];
    const params: unknown[] = [companyId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.direction) add('direction = ?', f.direction);
    if (f.status) add('status = ?', f.status);
    if (f.from) add('issue_date >= ?::date', f.from);
    if (f.to) add('issue_date <= ?::date', f.to);
    if (f.cursor) {
      params.push(f.cursor.issueDate, f.cursor.id);
      where.push(`(issue_date, id) < ($${params.length - 1}::date, $${params.length}::uuid)`);
    }
    params.push(f.limit + 1);
    const rows = await this.db.query<R>(
      `SELECT ${INV} FROM invoices WHERE ${where.join(' AND ')} ORDER BY issue_date DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toInvoice);
  }

  /** Dublikat yoxlaması üçün: eyni istiqamət + nömrə (özü xaric). */
  async sameNumber(
    companyId: string,
    direction: string,
    number: string,
    excludeId: string | null,
  ): Promise<
    Array<{
      id: string;
      direction: 'sales' | 'purchase';
      number: string;
      counterpartyVoen: string | null;
    }>
  > {
    const rows = await this.db.query<R>(
      `SELECT i.id, i.direction, i.number, c.voen FROM invoices i LEFT JOIN counterparties c ON c.id = i.counterparty_id
        WHERE i.company_id = $1 AND i.direction = $2 AND upper(regexp_replace(i.number, '\\s+', '', 'g')) = upper(regexp_replace($3, '\\s+', '', 'g'))
          AND i.deleted_at IS NULL AND ($4::uuid IS NULL OR i.id <> $4::uuid)`,
      [companyId, direction, number, excludeId],
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      direction: r['direction'] as 'sales' | 'purchase',
      number: r['number'] as string,
      counterpartyVoen: r['voen'] as string | null,
    }));
  }
}
