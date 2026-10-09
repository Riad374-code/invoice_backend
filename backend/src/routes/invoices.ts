import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditRequest } from '../audit/http.js';
import { assertLocalDate, formatAmount } from '../accounting/index.js';
import { createRepos, type Repos } from '../db/index.js';
import { INVOICE_STATUSES, type InvoiceRow } from '../db/repos/invoices.js';
import { PERMISSIONS } from '../domain/index.js';
import { ApiError, errorResponses } from '../error.js';
import { ingestUpload } from '../files/upload.js';
import { persistProposalForInvoice } from '../ledger/service.js';
import { lowConfidenceFields, transitionInvoice, validateInvoice } from '../invoices/service.js';
import { QUEUES } from '../jobs/types.js';
import { requireAuth } from '../plugins/auth.js';

const Money = z.string().regex(/^-?\d+(\.\d+)?$/);
const LineSchema = z.object({
  id: z.uuid(),
  lineNo: z.number().int(),
  description: z.string(),
  qty: z.string(),
  unitPrice: z.string(),
  vatRateCode: z.string(),
  net: Money,
  vat: Money,
  accountSuggestion: z.string().nullable(),
  accountSuggestionConfidence: z.string().nullable(),
  accountFinal: z.string().nullable(),
});
const IssueSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  detail: z.string(),
  lineNo: z.number().int().nullable(),
  field: z.string().nullable(),
});
const InvoiceSchema = z.object({
  id: z.uuid(),
  direction: z.enum(['sales', 'purchase']),
  number: z.string(),
  issueDate: z.string(),
  counterparty: z
    .object({
      id: z.uuid(),
      name: z.string(),
      voen: z.string().nullable(),
      isVatPayer: z.boolean().nullable(),
    })
    .nullable(),
  currency: z.string(),
  net: Money,
  vat: Money,
  gross: Money,
  status: z.enum(INVOICE_STATUSES),
  sourceFileId: z.uuid().nullable(),
  extractionConfidence: z.string().nullable(),
  templateVersion: z.string().nullable(),
  aiModelVersion: z.string().nullable(),
  /** AI etibarlılığı < hədd olan sahələr — UI sarı işarələyir, insan yoxlaması tələb olunur */
  lowConfidenceFields: z.array(z.string()),
  fieldConfidence: z.record(z.string(), z.number()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const DetailSchema = InvoiceSchema.extend({
  lines: z.array(LineSchema),
  issues: z.array(IssueSchema),
});
const IdParams = z.object({ id: z.uuid() });

const EntryLineSchema = z.object({
  accountCode: z.string(),
  debit: Money,
  credit: Money,
  description: z.string().nullable(),
});
const ProposalSchema = z.object({
  id: z.uuid(),
  date: z.string(),
  description: z.string(),
  status: z.literal('proposed'),
  lines: z.array(EntryLineSchema),
  explanation: z.array(z.string()),
});

export default async function invoiceRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  async function detail(repos: Repos, companyId: string, inv: InvoiceRow) {
    const [lines, issues, cp] = await Promise.all([
      repos.invoices.lines(companyId, inv.id),
      repos.invoices.issues(companyId, inv.id),
      inv.counterpartyId ? repos.invoices.getCounterparty(companyId, inv.counterpartyId) : null,
    ]);
    return { ...head(inv, cp), lines, issues };
  }
  const head = (
    inv: InvoiceRow,
    cp: { id: string; name: string; voen: string | null; isVatPayer: boolean | null } | null,
  ) => ({
    id: inv.id,
    direction: inv.direction,
    number: inv.number,
    issueDate: inv.issueDate,
    counterparty: cp
      ? { id: cp.id, name: cp.name, voen: cp.voen, isVatPayer: cp.isVatPayer }
      : null,
    currency: inv.currency,
    net: inv.net,
    vat: inv.vat,
    gross: inv.gross,
    status: inv.status,
    sourceFileId: inv.sourceFileId,
    extractionConfidence: inv.extractionConfidence,
    templateVersion: inv.templateVersion,
    aiModelVersion: inv.aiModelVersion,
    lowConfidenceFields: lowConfidenceFields(
      inv.fieldConfidence,
      app.ctx.config.extractionReviewThreshold,
    ),
    fieldConfidence: inv.fieldConfidence,
    createdAt: inv.createdAt.toISOString(),
    updatedAt: inv.updatedAt.toISOString(),
  });
  const load = async (companyId: string, id: string) => {
    const inv = await app.ctx.repos.invoices.find(companyId, id);
    if (!inv) throw ApiError.notFound(`Invoice ${id} not found`); // A-05: fallback yoxdur
    return inv;
  };

  typed.post(
    '/api/v1/invoices/upload',
    {
      schema: {
        tags: ['invoices'],
        summary: 'e-qaimə XML yüklə (multipart: file); AI-sız şablon parse işə düşür',
        consumes: ['multipart/form-data'],
        security: [{ bearerAuth: [] }],
        response: {
          202: z.object({ fileId: z.uuid(), fileVersionId: z.uuid() }),
          ...errorResponses(401, 403, 413, 422, 503),
        },
      },
      config: { permission: PERMISSIONS.INVOICES_WRITE },
    },
    async (request, reply) => {
      const { file, version } = await ingestUpload(app, request, {
        extraJobs: (v) => [
          {
            queue: QUEUES.INVOICE_PARSE,
            payload: { fileVersionId: v.id },
            maxAttempts: 8,
            idempotencyKey: `invoice-parse:${v.id}`,
          },
        ],
      });
      void reply.status(202);
      return { fileId: file.id, fileVersionId: version.id };
    },
  );

  typed.get(
    '/api/v1/invoices',
    {
      schema: {
        tags: ['invoices'],
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          direction: z.enum(['sales', 'purchase']).optional(),
          status: z.enum(INVOICE_STATUSES).optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          cursor: z.string().max(200).optional(),
        }),
        response: {
          200: z.object({ items: z.array(InvoiceSchema), nextCursor: z.string().nullable() }),
          ...errorResponses(401, 403, 422),
        },
      },
      config: { permission: PERMISSIONS.INVOICES_READ },
    },
    async (request) => {
      const auth = requireAuth(request);
      const q = request.query;
      for (const d of [q.from, q.to])
        if (d !== undefined) {
          try {
            assertLocalDate(d);
          } catch {
            throw ApiError.validation('from/to must be YYYY-MM-DD');
          }
        }
      let cursor;
      if (q.cursor) {
        try {
          const c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString()) as {
            d: string;
            i: string;
          };
          assertLocalDate(c.d);
          cursor = { issueDate: c.d, id: z.uuid().parse(c.i) };
        } catch {
          throw ApiError.validation('Invalid cursor');
        }
      }
      const rows = await app.ctx.repos.invoices.list(auth.companyId, { ...q, cursor });
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      const cps = new Map<
        string,
        Awaited<ReturnType<typeof app.ctx.repos.invoices.getCounterparty>>
      >();
      for (const r of page)
        if (r.counterpartyId && !cps.has(r.counterpartyId))
          cps.set(
            r.counterpartyId,
            await app.ctx.repos.invoices.getCounterparty(auth.companyId, r.counterpartyId),
          );
      return {
        items: page.map((r) => head(r, (r.counterpartyId && cps.get(r.counterpartyId)) || null)),
        nextCursor:
          rows.length > q.limit && last
            ? Buffer.from(JSON.stringify({ d: last.issueDate, i: last.id })).toString('base64url')
            : null,
      };
    },
  );

  typed.get(
    '/api/v1/invoices/:id',
    {
      schema: {
        tags: ['invoices'],
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: { 200: DetailSchema, ...errorResponses(401, 403, 404, 422) },
      },
      config: { permission: PERMISSIONS.INVOICES_READ },
    },
    async (request) => {
      const auth = requireAuth(request);
      return detail(app.ctx.repos, auth.companyId, await load(auth.companyId, request.params.id));
    },
  );

  typed.patch(
    '/api/v1/invoices/:id',
    {
      schema: {
        tags: ['invoices'],
        summary:
          'Başlıq və sətir məlumatlarını düzəlt; status yenidən "extracted" olur və təkrar yoxlama tələb edir',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: z
          .object({
            number: z.string().trim().min(1).max(100).optional(),
            issueDate: z.string().optional(),
            currency: z.string().length(3).optional(),
            net: Money.optional(),
            vat: Money.optional(),
            gross: Money.optional(),
            lines: z
              .array(
                z.object({
                  id: z.uuid(),
                  accountFinal: z
                    .string()
                    .regex(/^\d{3,6}$/)
                    .nullable()
                    .optional(),
                  description: z.string().trim().min(1).max(1000).optional(),
                  qty: Money.optional(),
                  unitPrice: Money.optional(),
                  vatRateCode: z.string().min(1).max(60).optional(),
                  net: Money.optional(),
                  vat: Money.optional(),
                }),
              )
              .max(500)
              .optional(),
          })
          .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field' }),
        response: { 200: DetailSchema, ...errorResponses(401, 403, 404, 409, 422) },
      },
      config: { permission: PERMISSIONS.INVOICES_WRITE },
    },
    async (request) => {
      const auth = requireAuth(request);
      const b = request.body;
      if (b.issueDate !== undefined) {
        try {
          assertLocalDate(b.issueDate);
        } catch {
          throw ApiError.validation('issueDate must be YYYY-MM-DD');
        }
      }
      return app.ctx.db.tx(async (tx) => {
        const repos = createRepos(tx);
        const before = await repos.invoices.lock(auth.companyId, request.params.id);
        if (!before) throw ApiError.notFound(`Invoice ${request.params.id} not found`);
        if (before.status === 'posted') throw ApiError.conflict('Posted invoices cannot be edited');
        const current = await repos.invoices.lines(auth.companyId, before.id);
        const byId = new Map(current.map((l) => [l.id, l]));
        for (const l of b.lines ?? [])
          if (!byId.has(l.id))
            throw ApiError.validation(`Line ${l.id} does not belong to this invoice`);
        const { lines, ...header } = b;
        await repos.invoices.updateHeader(auth.companyId, before.id, {
          ...header,
          status: transitionInvoice(before.status, 'extracted'),
        });

        // İnsan düzəlişi = həmin sahə artıq yoxlanılıb (etibarlılıq 1); AI təklifi ilə fərq model təlimi üçün saxlanılır
        const fc = { ...before.fieldConfidence };
        for (const k of Object.keys(header)) if (k in fc) fc[k] = 1;
        for (const l of lines ?? []) {
          const existing = byId.get(l.id)!;
          const idx = existing.lineNo - 1;
          const { id: _id, accountFinal, ...fields } = l;
          const changed = Object.entries(fields).filter(([, v]) => v !== undefined);
          if (changed.length) {
            await repos.invoices.updateLine(auth.companyId, l.id, fields);
            for (const [k] of changed)
              fc[`lines.${idx}.${k === 'vatRateCode' ? 'vatRateCode' : k}`] = 1;
          }
          if (accountFinal !== undefined) {
            await repos.invoices.setLineAccount(auth.companyId, l.id, accountFinal);
            if (existing.accountSuggestion && accountFinal) {
              await repos.assistant.addLineFeedback({
                companyId: auth.companyId,
                userId: auth.userId,
                invoiceLineId: l.id,
                kind:
                  accountFinal === existing.accountSuggestion ? 'approval_decision' : 'correction',
                before: {
                  accountSuggestion: existing.accountSuggestion,
                  confidence: existing.accountSuggestionConfidence,
                  modelVersion: before.aiModelVersion,
                },
                after: { accountFinal },
              });
            }
          }
        }
        if (Object.keys(fc).length)
          await repos.invoices.setFieldConfidence(auth.companyId, before.id, fc);
        const after = (await repos.invoices.find(auth.companyId, before.id))!;
        await auditRequest(
          app,
          request,
          {
            action: 'invoice.update',
            resourceType: 'invoice',
            resourceId: before.id,
            before: {
              number: before.number,
              issueDate: before.issueDate,
              currency: before.currency,
              net: before.net,
              vat: before.vat,
              gross: before.gross,
              status: before.status,
            },
            after: { ...header, lines, status: after.status },
          },
          tx,
        );
        return detail(repos, auth.companyId, after) as never;
      });
    },
  );

  typed.post(
    '/api/v1/invoices/:id/validate',
    {
      schema: {
        tags: ['invoices'],
        summary: 'accounting.invoice.check işlət, invoice_issues-i yenilə',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: { 200: DetailSchema, ...errorResponses(401, 403, 404, 409, 422) },
      },
      config: { permission: PERMISSIONS.INVOICES_WRITE },
    },
    async (request) => {
      const auth = requireAuth(request);
      return app.ctx.db.tx(async (tx) => {
        const repos = createRepos(tx);
        const inv = await repos.invoices.lock(auth.companyId, request.params.id);
        if (!inv) throw ApiError.notFound(`Invoice ${request.params.id} not found`);
        if (inv.status === 'posted')
          throw ApiError.conflict('Posted invoices cannot be re-validated');
        const out = await validateInvoice(repos, inv);
        await auditRequest(
          app,
          request,
          {
            action: 'invoice.validate',
            resourceType: 'invoice',
            resourceId: inv.id,
            before: { status: inv.status },
            after: { status: out.status, issues: out.issues.map((i) => i.code) },
          },
          tx,
        );
        return detail(
          repos,
          auth.companyId,
          (await repos.invoices.find(auth.companyId, inv.id))!,
        ) as never;
      });
    },
  );

  typed.post(
    '/api/v1/invoices/:id/propose-entries',
    {
      schema: {
        tags: ['invoices'],
        summary: 'Qaimədən TƏKLİF olunan jurnal yazılışı (yazılmır; təsdiq B11)',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: z
          .object({
            accountMapping: z
              .object({
                receivable: z.string(),
                payable: z.string(),
                revenue: z.string(),
                expense: z.string(),
                vatOutput: z.string(),
                vatInput: z.string(),
              })
              .optional(),
            vatDeductible: z.boolean().optional(),
          })
          .default({}),
        response: { 200: ProposalSchema, ...errorResponses(401, 403, 404, 409, 422) },
      },
      config: { permission: PERMISSIONS.INVOICES_WRITE },
    },
    async (request) => {
      const auth = requireAuth(request);
      const inv = await load(auth.companyId, request.params.id);
      if (inv.status === 'needs_review' || inv.status === 'extracted')
        throw ApiError.conflict('Validate the invoice (no errors) before proposing entries');
      if (inv.status === 'posted') throw ApiError.conflict('Invoice is already booked');
      // Təklif DB-də `proposed` yazılış kimi saxlanılır (post etmək ayrıca təsdiq tələb edir: POST /journal/{id}/submit)
      const out = await app.ctx.db.tx(async (tx) => {
        const r = createRepos(tx);
        const proposal = await persistProposalForInvoice(r, inv, auth.userId, {
          ...(request.body.accountMapping ? { mapping: request.body.accountMapping } : {}),
          ...(request.body.vatDeductible !== undefined
            ? { vatDeductible: request.body.vatDeductible }
            : {}),
        });
        await auditRequest(
          app,
          request,
          {
            action: 'invoice.propose_entries',
            resourceType: 'invoice',
            resourceId: inv.id,
            after: { journalEntryId: proposal.entryId },
          },
          tx,
        );
        return proposal;
      });
      const entry = out.entry;
      return {
        id: out.entryId,
        date: entry.date,
        description: entry.description,
        status: entry.status,
        explanation: entry.explanation,
        lines: entry.lines.map((l) => ({
          accountCode: l.accountCode,
          debit: formatAmount(l.debit),
          credit: formatAmount(l.credit),
          description: l.description,
        })),
      };
    },
  );
}
