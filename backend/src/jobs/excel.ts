import { createGeneratedFile } from '../files/generated.js';
import { cleanTable, profileTable } from '../documents/excel-ops.js';
import { writeWorkbook, type SheetSpec } from '../documents/table.js';
import { journalReportRows, invoiceReportRows } from '../excel/reports.js';
import { loadTable, refJson, runReconciliation, type SourceSpec } from '../recon/service.js';
import type { Repos, Db } from '../db/index.js';
import type { ObjectStorage } from '../storage/index.js';
import { PermanentJobError, type JobHandler } from './types.js';

export type ExcelParams = {
  dedupe?: boolean;
  left?: SourceSpec;
  right?: SourceSpec;
  template?: 'invoices' | 'journal';
  from?: string;
  to?: string;
};

/** Excel job-un icrası: yeni XLSX yaradır (orijinal fayl dəyişmir) və `output_file_id` yazır. Job-dan və alətdən istifadə olunur. */
export async function runExcelJob(
  deps: { db: Db; repos: Repos; storage: ObjectStorage },
  companyId: string,
  jobId: string,
): Promise<{ outputFileId: string; result: unknown }> {
  const job = await deps.repos.excel.getJob(companyId, jobId);
  if (!job) throw new PermanentJobError(`Excel job ${jobId} not found`);
  await deps.repos.excel.setJob(jobId, { status: 'running' });
  const params = (job.params ?? {}) as ExcelParams;
  let sheets: SheetSpec[];
  let result: unknown;
  let baseName: string = job.operation;

  if (job.operation === 'profile' || job.operation === 'clean') {
    if (!job.inputFileId) throw new PermanentJobError(`${job.operation} needs an input file`);
    const file = (await deps.repos.files.findById(companyId, job.inputFileId))!;
    baseName = `${job.operation}-${file.name.replace(/\.[^.]+$/, '')}`;
    const t = await loadTable(deps, companyId, job.inputFileId);
    if (job.operation === 'profile') {
      const p = profileTable(t.headers, t.rows);
      result = { ...p, truncated: t.truncated };
      sheets = [
        {
          name: 'Summary',
          headers: ['Metric', 'Value'],
          rows: [
            ['Rows', p.rows],
            ['Empty rows', p.emptyRows],
            ['Duplicate rows', p.duplicateRows],
            ['Truncated', String(t.truncated)],
          ],
        },
        {
          name: 'Columns',
          headers: [
            'Column',
            'Type',
            'Non-empty',
            'Distinct',
            'Sum',
            'Min',
            'Max',
            'Unparsable',
            'Samples',
          ],
          rows: p.columns.map((c) => [
            c.name,
            c.type,
            c.nonEmpty,
            c.distinct,
            c.sum ?? '',
            c.min ?? '',
            c.max ?? '',
            c.unparsable,
            c.samples.join(' | '),
          ]),
        },
      ];
    } else {
      const c = cleanTable(t.headers, t.rows, { dedupe: params.dedupe ?? true });
      result = { rowsIn: t.rows.length, rowsOut: c.rows.length, log: c.log };
      sheets = [
        { name: 'Cleaned', headers: t.headers, rows: c.rows },
        {
          name: 'Log',
          headers: ['Change', 'Count'],
          rows: Object.entries(c.log).map(([k, v]) => [k, v]),
        },
      ];
    }
  } else if (job.operation === 'reconcile') {
    if (!params.left || !params.right)
      throw new PermanentJobError('reconcile needs params.left and params.right');
    const out = await runReconciliation(deps, companyId, params.left, params.right);
    result = out.summary;
    const row = (m: (typeof out.matches)[number]) => [
      m.type,
      m.confidence.toString(),
      m.left?.ref ?? '',
      m.left?.key ?? '',
      m.left?.amount.toFixed(2) ?? '',
      m.right?.ref ?? '',
      m.right?.key ?? '',
      m.right?.amount.toFixed(2) ?? '',
      m.difference?.toFixed(2) ?? '',
      m.explanation,
    ];
    const head = [
      'Type',
      'Confidence',
      'Left ref',
      'Left key',
      'Left amount',
      'Right ref',
      'Right key',
      'Right amount',
      'Difference',
      'Explanation',
    ];
    sheets = [
      {
        name: 'Summary',
        headers: ['Metric', 'Value'],
        rows: Object.entries(out.summary).map(([k, v]) => [k, v]),
      },
      {
        name: 'Matched',
        headers: head,
        rows: out.matches.filter((m) => !m.type.startsWith('unmatched')).map(row),
      },
      {
        name: 'Unmatched',
        headers: head,
        rows: out.matches.filter((m) => m.type.startsWith('unmatched')).map(row),
      },
      {
        name: 'Skipped',
        headers: ['Ref', 'Reason'],
        rows: out.skipped.map((s) => [s.ref, s.reason]),
      },
    ];
    void refJson;
  } else {
    if (!params.from || !params.to || !params.template)
      throw new PermanentJobError('report needs template, from and to');
    const spec =
      params.template === 'invoices'
        ? await invoiceReportRows(deps.repos, companyId, params.from, params.to)
        : await journalReportRows(deps.repos, companyId, params.from, params.to);
    result = { template: params.template, rows: spec.rows.length };
    baseName = `report-${params.template}-${params.from}_${params.to}`;
    sheets = [spec];
  }

  const buf = await writeWorkbook(sheets);
  const file = await createGeneratedFile(deps, {
    companyId,
    userId: job.createdBy,
    name: `${baseName}.xlsx`,
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: buf,
    folder: '/excel/output',
    tags: ['excel', job.operation],
  });
  await deps.repos.excel.setJob(jobId, { status: 'done', outputFileId: file.id, result });
  return { outputFileId: file.id, result };
}

export const excelRunHandler: JobHandler = async (job, deps) => {
  const jobId = (job.payload as { excelJobId?: string } | null)?.excelJobId;
  if (!jobId || !job.companyId)
    throw new PermanentJobError('excel.run needs companyId and payload.excelJobId');
  try {
    const out = await runExcelJob(deps, job.companyId, jobId);
    return { outputFileId: out.outputFileId };
  } catch (e) {
    const final = e instanceof PermanentJobError || job.attempts >= job.maxAttempts;
    if (final)
      await deps.repos.excel.setJob(jobId, {
        status: 'failed',
        error: (e as Error).message.slice(0, 1000),
      });
    throw e;
  }
};
