import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertLocalDate, formatAmount } from '../accounting/index.js';
import { auditRequest } from '../audit/http.js';
import { createRepos } from '../db/index.js';
import { PERMISSIONS } from '../domain/index.js';
import { ApiError, errorResponses } from '../error.js';
import { ImportError, previewImport, requestImportCommit } from '../imports/service.js';
import { QUEUES } from '../jobs/types.js';
import { requireAuth } from '../plugins/auth.js';
import { refJson, runReconciliation, type SourceSpec } from '../recon/service.js';
import { DomainError } from '../domain/index.js';
import { createGeneratedFile } from '../files/generated.js';

const Day = z.string().refine((d) => {
  try {
    assertLocalDate(d);
    return true;
  } catch {
    return false;
  }
}, 'must be YYYY-MM-DD');
const SourceSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('file'),
      fileId: z.uuid(),
      keyColumn: z.string().min(1),
      amountColumn: z.string().min(1),
      dateColumn: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('invoices'),
      from: Day,
      to: Day,
      direction: z.enum(['sales', 'purchase']).optional(),
    })
    .strict(),
  z.object({ type: z.literal('bank'), from: Day.optional(), to: Day.optional() }).strict(),
]);
const JobSchema = z.object({
  id: z.uuid(),
  operation: z.enum(['profile', 'clean', 'reconcile', 'report']),
  inputFileId: z.uuid().nullable(),
  outputFileId: z.uuid().nullable(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  result: z.unknown(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
const IdParams = z.object({ id: z.uuid() });

export default async function excelRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const deps = () => ({ repos: app.ctx.repos, storage: app.ctx.storage });
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ImportError) throw ApiError.validation(e.message);
      if (e instanceof DomainError && e.kind === 'VALIDATION') throw ApiError.validation(e.message);
      throw e;
    }
  };

  // ------------------------------------------------------------ excel jobs
  typed.post(
    '/api/v1/excel/jobs',
    {
      schema: {
        tags: ['excel'],
        summary:
          'Excel işi: profile | clean | reconcile | report — nəticə YENİ fayldır (output_file_id), orijinal dəyişmir',
        security: [{ bearerAuth: [] }],
        body: z.discriminatedUnion('operation', [
          z.object({ operation: z.literal('profile'), inputFileId: z.uuid() }),
          z.object({
            operation: z.literal('clean'),
            inputFileId: z.uuid(),
            params: z.object({ dedupe: z.boolean().default(true) }).default({ dedupe: true }),
          }),
          z.object({
            operation: z.literal('reconcile'),
            params: z.object({ left: SourceSchema, right: SourceSchema }),
          }),
          z.object({
            operation: z.literal('report'),
            params: z.object({ template: z.enum(['invoices', 'journal']), from: Day, to: Day }),
          }),
        ]),
        response: { 202: JobSchema, ...errorResponses(401, 403, 404, 422) },
      },
      config: { permission: PERMISSIONS.EXCEL_USE },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const b = request.body;
      const inputFileId = 'inputFileId' in b ? b.inputFileId : null;
      if (inputFileId && !(await app.ctx.repos.files.findById(auth.companyId, inputFileId)))
        throw ApiError.notFound('Input file not found');
      const params = 'params' in b ? b.params : {};
      const id = await app.ctx.db.tx(async (tx) => {
        const r = createRepos(tx);
        const jid = await r.excel.createJob({
          companyId: auth.companyId,
          userId: auth.userId,
          operation: b.operation,
          inputFileId,
          params,
        });
        await r.jobs.enqueue({
          queue: QUEUES.EXCEL_RUN,
          companyId: auth.companyId,
          payload: { excelJobId: jid },
          idempotencyKey: `excel:${jid}`,
          maxAttempts: 3,
        });
        await auditRequest(
          app,
          request,
          {
            action: 'excel.job',
            resourceType: 'excel_job',
            resourceId: jid,
            after: { operation: b.operation, inputFileId },
          },
          tx,
        );
        return jid;
      });
      void reply.status(202);
      return toJob((await app.ctx.repos.excel.getJob(auth.companyId, id))!);
    },
  );

  typed.get(
    '/api/v1/excel/jobs/:id',
    {
      schema: {
        tags: ['excel'],
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: { 200: JobSchema, ...errorResponses(401, 403, 404, 422) },
      },
      config: { permission: PERMISSIONS.EXCEL_USE },
    },
    async (request) => {
      const j = await app.ctx.repos.excel.getJob(requireAuth(request).companyId, request.params.id);
      if (!j) throw ApiError.notFound('Excel job not found');
      return toJob(j);
    },
  );

  // -------------------------------------------------------- reconciliations
  const MatchSchema = z.object({
    id: z.uuid(),
    matchType: z.string(),
    confidence: z.string(),
    left: z.unknown(),
    right: z.unknown(),
    difference: z.string().nullable(),
    explanation: z.string(),
    status: z.enum(['proposed', 'confirmed']),
  });
  typed.post(
    '/api/v1/reconciliations',
    {
      schema: {
        tags: ['recon'],
        summary:
          'İki mənbəni uzlaşdır (fayl / qaimələr / bank). Nəticələr TƏKLİFDİR; insan confirm edir',
        security: [{ bearerAuth: [] }],
        body: z.object({ left: SourceSchema, right: SourceSchema }),
        response: {
          201: z.object({ id: z.uuid(), summary: z.unknown() }),
          ...errorResponses(401, 403, 404, 422),
        },
      },
      config: { permission: PERMISSIONS.EXCEL_USE },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const out = await wrap(() =>
        runReconciliation(
          deps(),
          auth.companyId,
          request.body.left as SourceSpec,
          request.body.right as SourceSpec,
        ),
      );
      const id = await app.ctx.db.tx(async (tx) => {
        const rid = await createRepos(tx).excel.createRecon({
          companyId: auth.companyId,
          userId: auth.userId,
          left: out.left,
          right: out.right,
          summary: { ...out.summary, skippedRows: out.skipped },
          matches: out.matches.map((m) => ({
            type: m.type,
            confidence: m.confidence.toFixed(3),
            left: refJson(m.left),
            right: refJson(m.right),
            difference: m.difference ? formatAmount(m.difference) : null,
            explanation: m.explanation,
          })),
        });
        await auditRequest(
          app,
          request,
          {
            action: 'reconciliation.run',
            resourceType: 'reconciliation',
            resourceId: rid,
            after: out.summary,
          },
          tx,
        );
        return rid;
      });
      void reply.status(201);
      return { id, summary: out.summary };
    },
  );

  typed.get(
    '/api/v1/reconciliations/:id',
    {
      schema: {
        tags: ['recon'],
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          200: z.object({
            id: z.uuid(),
            leftSource: z.string(),
            rightSource: z.string(),
            status: z.string(),
            summary: z.unknown(),
            matches: z.array(MatchSchema),
          }),
          ...errorResponses(401, 403, 404, 422),
        },
      },
      config: { permission: PERMISSIONS.EXCEL_USE },
    },
    async (request) => {
      const auth = requireAuth(request);
      const r = await app.ctx.repos.excel.getRecon(auth.companyId, request.params.id);
      if (!r) throw ApiError.notFound('Reconciliation not found');
      const ms = await app.ctx.repos.excel.matches(auth.companyId, r.id);
      return {
        id: r.id,
        leftSource: r.leftSource,
        rightSource: r.rightSource,
        status: r.status,
        summary: r.summary,
        matches: ms.map((m) => ({
          id: m.id,
          matchType: m.matchType,
          confidence: m.confidence,
          left: m.leftRef,
          right: m.rightRef,
          difference: m.difference,
          explanation: m.explanation,
          status: m.status,
        })),
      };
    },
  );

  typed.post(
    '/api/v1/reconciliations/:id/matches/:m/confirm',
    {
      schema: {
        tags: ['recon'],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.uuid(), m: z.uuid() }),
        response: {
          200: z.object({ status: z.literal('confirmed') }),
          ...errorResponses(401, 403, 404, 409, 422),
        },
      },
      config: { permission: PERMISSIONS.EXCEL_USE },
    },
    async (request) => {
      const auth = requireAuth(request);
      return app.ctx.db.tx(async (tx) => {
        const res = await createRepos(tx).excel.confirmMatch(
          auth.companyId,
          request.params.id,
          request.params.m,
          auth.userId,
          new Date(),
        );
        if (res === 'not_found') throw ApiError.notFound('Match not found');
        if (res === 'not_confirmable')
          throw ApiError.conflict('Unmatched rows cannot be confirmed');
        if (res === 'confirmed')
          await auditRequest(
            app,
            request,
            {
              action: 'reconciliation.confirm',
              resourceType: 'reconciliation_match',
              resourceId: request.params.m,
              after: { reconciliationId: request.params.id },
            },
            tx,
          );
        else request.auditRecorded = true;
        return { status: 'confirmed' as const };
      });
    },
  );

  // ---------------------------------------------------------------- imports
  const PreviewResp = z.object({
    importId: z.uuid(),
    template: z.string(),
    rowsOk: z.number().int(),
    rowsFailed: z.number().int(),
    truncated: z.boolean(),
    errors: z.array(z.object({ row: z.number().int(), errors: z.array(z.string()) })),
    sample: z.array(z.unknown()),
  });
  typed.post(
    '/api/v1/imports/preview',
    {
      schema: {
        tags: ['imports'],
        summary: 'İmport ÖNBAXIŞI (heç nə yazılmır): şablon, düzgün/səhv sətirlər',
        security: [{ bearerAuth: [] }],
        body: z.object({
          source: z.enum(['1c', 'etaxes', 'bank']),
          fileId: z.uuid(),
          defaultDirection: z.enum(['sales', 'purchase']).optional(),
        }),
        response: { 201: PreviewResp, ...errorResponses(401, 403, 404, 422) },
      },
      config: { permission: PERMISSIONS.EXCEL_USE },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const out = await wrap(() =>
        previewImport(deps(), { companyId: auth.companyId, userId: auth.userId, ...request.body }),
      );
      request.auditRecorded = true;
      await auditRequest(app, request, {
        action: 'import.preview',
        resourceType: 'import_job',
        resourceId: out.importId,
        after: {
          source: request.body.source,
          rowsOk: out.preview.rowsOk,
          rowsFailed: out.preview.rowsFailed,
        },
      });
      void reply.status(201);
      return {
        importId: out.importId,
        template: out.preview.template,
        rowsOk: out.preview.rowsOk,
        rowsFailed: out.preview.rowsFailed,
        truncated: out.preview.truncated,
        errors: out.preview.rows
          .filter((r) => !r.ok)
          .slice(0, 100)
          .map((r) => ({ row: r.row, errors: r.errors })),
        sample: out.preview.rows
          .filter((r) => r.ok)
          .slice(0, 5)
          .map((r) => r.data),
      };
    },
  );

  typed.get(
    '/api/v1/imports/:id',
    {
      schema: {
        tags: ['imports'],
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          200: z.object({
            id: z.uuid(),
            source: z.string(),
            template: z.string().nullable(),
            status: z.string(),
            rowsOk: z.number().int(),
            rowsFailed: z.number().int(),
            approvalId: z.uuid().nullable(),
            error: z.string().nullable(),
          }),
          ...errorResponses(401, 403, 404, 422),
        },
      },
      config: { permission: PERMISSIONS.EXCEL_USE },
    },
    async (request) => {
      const j = await app.ctx.repos.excel.getImport(
        requireAuth(request).companyId,
        request.params.id,
      );
      if (!j) throw ApiError.notFound('Import not found');
      return {
        id: j.id,
        source: j.source,
        template: j.templateVersion,
        status: j.status,
        rowsOk: j.rowsOk,
        rowsFailed: j.rowsFailed,
        approvalId: j.approvalId,
        error: j.error,
      };
    },
  );

  typed.post(
    '/api/v1/imports/:id/commit',
    {
      schema: {
        tags: ['imports'],
        summary:
          'Önbaxışı tətbiq etmək üçün TƏSDİQ sorğusu (başqa istifadəçi təsdiqləyəndə yazılır)',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          202: z.object({
            importId: z.uuid(),
            approvalId: z.uuid(),
            status: z.literal('approval_required'),
            reused: z.boolean(),
          }),
          ...errorResponses(401, 403, 404, 409, 422),
        },
      },
      config: { permission: PERMISSIONS.IMPORTS_COMMIT },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const out = await app.ctx.db.tx(async (tx) => {
        const res = await wrap(() =>
          requestImportCommit(
            createRepos(tx),
            auth.companyId,
            request.params.id,
            auth.userId,
            new Date(),
          ),
        );
        if (!res.reused)
          await auditRequest(
            app,
            request,
            {
              action: 'import.commit_requested',
              resourceType: 'import_job',
              resourceId: request.params.id,
              after: { approvalId: res.approval.id },
            },
            tx,
          );
        else request.auditRecorded = true;
        return res;
      });
      void reply.status(202);
      return {
        importId: request.params.id,
        approvalId: out.approval.id,
        status: 'approval_required' as const,
        reused: out.reused,
      };
    },
  );

  // ------------------------------------------------------------- 1C export
  typed.post(
    '/api/v1/journal/export-1c',
    {
      schema: {
        tags: ['ledger'],
        summary: '1C üçün POST olunmuş yazılışların ixrac faylı (YENİ fayl; format lexaudit-1c-v1)',
        security: [{ bearerAuth: [] }],
        body: z.object({ from: Day, to: Day }),
        response: {
          201: z.object({ fileId: z.uuid(), entries: z.number().int() }),
          ...errorResponses(401, 403, 422),
        },
      },
      config: { permission: PERMISSIONS.JOURNAL_READ, skipAudit: true },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const out = await exportEntries1c(
        app.ctx,
        auth.companyId,
        auth.userId,
        request.body.from,
        request.body.to,
      );
      await auditRequest(app, request, {
        action: 'journal.export_1c',
        resourceType: 'file',
        resourceId: out.fileId,
        after: { entries: out.entries, from: request.body.from, to: request.body.to },
      });
      void reply.status(201);
      return out;
    },
  );
}

const toJob = (j: import('../db/repos/excel.js').ExcelJobRow) => ({
  id: j.id,
  operation: j.operation,
  inputFileId: j.inputFileId,
  outputFileId: j.outputFileId,
  status: j.status,
  result: j.result ?? null,
  error: j.error,
  createdAt: j.createdAt.toISOString(),
});

/** lexaudit-1c-v1: UTF-8 BOM, `;` ayırıcı, bir sətir = bir jurnal sətri (yalnız POSTED yazılışlar). */
export async function exportEntries1c(
  ctx: {
    repos: import('../db/index.js').Repos;
    db: import('../db/index.js').Db;
    storage: import('../storage/index.js').ObjectStorage;
  },
  companyId: string,
  userId: string,
  from: string,
  to: string,
): Promise<{ fileId: string; entries: number }> {
  const entries = (
    await ctx.repos.ledger.list(companyId, { status: 'posted', from, to, limit: 10_000 })
  ).slice(0, 10_000);
  const q = (v: string) => (/[;"\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const out = [
    '#LEXAUDIT-1C;v1;' + from + ';' + to,
    'date;entry_id;account;debit;credit;description',
  ];
  for (const e of entries)
    for (const l of await ctx.repos.ledger.lines(companyId, e.id))
      out.push(
        [
          e.entryDate,
          e.id,
          l.accountCode,
          l.debit,
          l.credit,
          q(l.description ?? e.description),
        ].join(';'),
      );
  const file = await createGeneratedFile(ctx, {
    companyId,
    userId,
    name: `1c-export-${from}_${to}.csv`,
    mime: 'text/csv',
    content: Buffer.from('﻿' + out.join('\r\n') + '\r\n', 'utf8'),
    folder: '/exports/1c',
    tags: ['1c-export'],
  });
  return { fileId: file.id, entries: entries.length };
}
