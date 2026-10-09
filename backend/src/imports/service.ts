import { D, formatAmount } from '../accounting/index.js';
import { type Repos } from '../db/index.js';
import { readTable } from '../documents/table.js';
import { parseInvoiceXml } from '../documents/etaxes.js';
import { DomainError, newApproval } from '../domain/index.js';
import { resolveRateCode } from '../invoices/ai-import.js';
import { validateInvoice } from '../invoices/service.js';
import type { ObjectStorage } from '../storage/index.js';
import {
  previewBankTable,
  previewOnecTable,
  type BankRowData,
  type ImportSource,
  type InvoiceRowData,
  type Preview,
} from './templates.js';

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export async function previewImport(
  deps: { repos: Repos; storage: ObjectStorage },
  input: {
    companyId: string;
    userId: string;
    source: ImportSource;
    fileId: string;
    defaultDirection?: 'sales' | 'purchase';
  },
): Promise<{ importId: string; preview: Preview }> {
  const file = await deps.repos.files.findById(input.companyId, input.fileId);
  if (!file) throw new DomainError('NOT_FOUND', 'File not found');
  const version = await deps.repos.files.latestVersion(input.companyId, file.id);
  if (!version) throw new DomainError('NOT_FOUND', 'File has no versions');
  const buffer = await deps.storage.get(version.storageKey);
  const company = (await deps.repos.companies.findById(input.companyId))!;

  let preview: Preview;
  if (input.source === 'etaxes') {
    if (version.mime !== 'application/xml')
      throw new ImportError('e-taxes import expects an XML export');
    const p = parseInvoiceXml(buffer.toString('utf8'));
    if (!p) throw new ImportError('XML does not match any known e-invoice template');
    const direction = p.seller.voen === company.voen ? 'sales' : 'purchase';
    const other = direction === 'sales' ? p.buyer : p.seller;
    const net = p.net ?? formatAmount(p.lines.reduce((a, l) => a.plus(l.net), new D(0)));
    const vat = p.vat ?? formatAmount(p.lines.reduce((a, l) => a.plus(l.vat), new D(0)));
    const data: InvoiceRowData = {
      kind: 'invoice',
      direction,
      number: p.number,
      issueDate: p.issueDate,
      counterpartyName: other.name,
      counterpartyVoen: other.voen,
      net,
      vat,
      gross: p.gross ?? formatAmount(new D(net).plus(vat)),
      currency: p.currency,
      vatPercent: null,
      lines: p.lines,
    };
    preview = {
      template: p.templateVersion,
      rows: [{ row: 1, ok: true, errors: [], data }],
      rowsOk: 1,
      rowsFailed: 0,
      truncated: false,
    };
  } else {
    const kind =
      version.mime === 'text/csv'
        ? 'csv'
        : version.mime.includes('spreadsheet') || version.mime === 'application/vnd.ms-excel'
          ? 'xlsx'
          : null;
    if (!kind) throw new ImportError(`${input.source} import expects an XLSX or CSV file`);
    const table = await readTable(buffer, kind).catch((e: Error) => {
      throw new ImportError(`Cannot read the file: ${e.message}`);
    });
    preview =
      input.source === '1c'
        ? previewOnecTable(table.headers, table.rows, {
            ...(input.defaultDirection ? { defaultDirection: input.defaultDirection } : {}),
            truncated: table.truncated,
          })
        : previewBankTable(table.headers, table.rows, { truncated: table.truncated });
  }
  const importId = await deps.repos.excel.createImport({
    companyId: input.companyId,
    userId: input.userId,
    source: input.source,
    fileId: file.id,
    templateVersion: preview.template,
    rowsOk: preview.rowsOk,
    rowsFailed: preview.rowsFailed,
    preview,
  });
  return { importId, preview };
}

/** İmport commit-i üçün TƏSDİQ sorğusu (yazma yalnız təsdiqdən sonra). */
export async function requestImportCommit(
  repos: Repos,
  companyId: string,
  importId: string,
  requesterId: string,
  now: Date,
) {
  const job = await repos.excel.getImport(companyId, importId, { forUpdate: true });
  if (!job) throw new DomainError('NOT_FOUND', 'Import not found');
  if (job.status !== 'previewed')
    throw new DomainError(
      'INVALID_STATE_TRANSITION',
      `Import is ${job.status}; only previewed imports can be committed`,
    );
  if (job.rowsOk === 0)
    throw new DomainError('VALIDATION', 'The preview has no valid rows to import');
  if (job.approvalId) {
    const existing = await repos.approvals.findById(job.approvalId);
    if (existing && existing.status === 'pending' && existing.expiresAt > now)
      return { approval: existing, reused: true };
  }
  const approval = await repos.approvals.create(
    newApproval({
      companyId,
      kind: 'import_commit',
      resourceRef: `import_job:${importId}`,
      requesterId,
      now,
      payload: {
        importId,
        source: job.source,
        template: job.templateVersion,
        rowsOk: job.rowsOk,
        rowsFailed: job.rowsFailed,
      },
      expiresAt: new Date(now.getTime() + 72 * 3_600_000),
    }),
  );
  await repos.excel.setImport(importId, { approvalId: approval.id });
  return { approval, reused: false };
}

export interface CommitReport {
  created: number;
  skippedDuplicates: number;
  invalidRows: number;
}

/** Transaksiya daxilində çağırılır. previewed → committed (təkrar commit mümkün deyil). */
export async function commitImport(
  repos: Repos,
  companyId: string,
  importId: string,
  _userId: string,
): Promise<CommitReport> {
  const job = await repos.excel.getImport(companyId, importId, { forUpdate: true });
  if (!job) throw new DomainError('NOT_FOUND', 'Import not found');
  if (job.status !== 'previewed')
    throw new DomainError('INVALID_STATE_TRANSITION', `Import is already ${job.status}`);
  const preview = job.preview as Preview;
  const ok = preview.rows.filter((r) => r.ok && r.data);
  const report: CommitReport = {
    created: 0,
    skippedDuplicates: 0,
    invalidRows: preview.rowsFailed,
  };

  if (job.source === 'bank') {
    report.created = await repos.excel.addBank(
      companyId,
      importId,
      ok.map((r) => r.data as BankRowData),
    );
  } else {
    const rates = await repos.taxRates.listActive('VAT');
    for (const row of ok) {
      const d = row.data as InvoiceRowData;
      const dups = (await repos.invoices.sameNumber(companyId, d.direction, d.number, null)).filter(
        (x) => (x.counterpartyVoen ?? null) === (d.counterpartyVoen ?? null),
      );
      if (dups.length) {
        report.skippedDuplicates++;
        continue;
      }
      const counterpartyId = await repos.invoices.upsertCounterparty(companyId, {
        name: d.counterpartyName,
        voen: d.counterpartyVoen,
        isVatPayer: null,
      });
      const lines = d.lines ?? [
        {
          description: `Import ${job.source} ${d.number}`,
          qty: '1',
          unitPrice: d.net,
          vatRateCode: resolveRateCode({ vatPercent: d.vatPercent }, rates, d.issueDate),
          net: d.net,
          vat: d.vat,
        },
      ];
      const id = await repos.invoices.create({
        companyId,
        direction: d.direction,
        number: d.number,
        issueDate: d.issueDate,
        counterpartyId,
        currency: d.currency,
        net: d.net,
        vat: d.vat,
        gross: d.gross,
        status: 'extracted',
        sourceFileId: job.fileId,
        extractionConfidence: '1.000',
        templateVersion: job.templateVersion,
        lines,
      });
      await validateInvoice(repos, (await repos.invoices.find(companyId, id))!);
      report.created++;
    }
  }
  await repos.excel.setImport(importId, {
    status: 'committed',
    rowsOk: report.created,
    rowsFailed: report.invalidRows + report.skippedDuplicates,
  });
  return report;
}
