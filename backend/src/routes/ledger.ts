import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditRequest } from '../audit/http.js';
import { assertLocalDate } from '../accounting/index.js';
import { createRepos } from '../db/index.js';
import type { EntryRow } from '../db/repos/ledger.js';
import { PERMISSIONS } from '../domain/index.js';
import { ApiError, errorResponses } from '../error.js';
import { PostingError, requestPosting } from '../ledger/service.js';
import { requireAuth } from '../plugins/auth.js';

const Money = z.string();
const LineSchema = z.object({
  lineNo: z.number().int(),
  accountCode: z.string(),
  debit: Money,
  credit: Money,
  description: z.string().nullable(),
});
const EntrySchema = z.object({
  id: z.uuid(),
  date: z.string(),
  description: z.string(),
  status: z.enum(['proposed', 'approved', 'posted']),
  source: z.enum(['invoice', 'manual', 'ai']),
  sourceInvoiceId: z.uuid().nullable(),
  approvalId: z.uuid().nullable(),
  postedAt: z.string().nullable(),
  createdAt: z.string(),
});
const AccountSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  nameAz: z.string(),
  nameRu: z.string().nullable(),
  nameEn: z.string().nullable(),
  type: z.string(),
  parentId: z.uuid().nullable(),
});
const IdParams = z.object({ id: z.uuid() });
const entry = (e: EntryRow) => ({
  id: e.id,
  date: e.entryDate,
  description: e.description,
  status: e.status,
  source: e.source,
  sourceInvoiceId: e.sourceInvoiceId,
  approvalId: e.approvalId,
  postedAt: e.postedAt?.toISOString() ?? null,
  createdAt: e.createdAt.toISOString(),
});

export default async function ledgerRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/api/v1/journal',
    {
      schema: {
        tags: ['ledger'],
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          status: z.enum(['proposed', 'approved', 'posted']).optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          cursor: z.string().max(200).optional(),
        }),
        response: {
          200: z.object({ items: z.array(EntrySchema), nextCursor: z.string().nullable() }),
          ...errorResponses(401, 403, 422),
        },
      },
      config: { permission: PERMISSIONS.JOURNAL_READ },
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
          cursor = { date: c.d, id: z.uuid().parse(c.i) };
        } catch {
          throw ApiError.validation('Invalid cursor');
        }
      }
      const rows = await app.ctx.repos.ledger.list(auth.companyId, { ...q, cursor });
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: page.map(entry),
        nextCursor:
          rows.length > q.limit && last
            ? Buffer.from(JSON.stringify({ d: last.entryDate, i: last.id })).toString('base64url')
            : null,
      };
    },
  );

  typed.get(
    '/api/v1/journal/:id',
    {
      schema: {
        tags: ['ledger'],
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          200: EntrySchema.extend({ lines: z.array(LineSchema) }),
          ...errorResponses(401, 403, 404, 422),
        },
      },
      config: { permission: PERMISSIONS.JOURNAL_READ },
    },
    async (request) => {
      const auth = requireAuth(request);
      const e = await app.ctx.repos.ledger.find(auth.companyId, request.params.id);
      if (!e) throw ApiError.notFound('Journal entry not found');
      return { ...entry(e), lines: await app.ctx.repos.ledger.lines(auth.companyId, e.id) };
    },
  );

  typed.post(
    '/api/v1/journal/:id/submit',
    {
      schema: {
        tags: ['ledger'],
        summary:
          'Yazılışı post etmək üçün TƏSDİQ sorğusu yarat (balanssız yazılış rədd olunur; təsdiq başqa istifadəçi tərəfindən verilməlidir)',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          202: z.object({
            entryId: z.uuid(),
            approvalId: z.uuid(),
            status: z.literal('approval_required'),
            reused: z.boolean(),
          }),
          ...errorResponses(401, 403, 404, 409, 422),
        },
      },
      config: { permission: PERMISSIONS.JOURNAL_WRITE },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const out = await app.ctx.db.tx(async (tx) => {
        let res;
        try {
          res = await requestPosting(
            createRepos(tx),
            auth.companyId,
            request.params.id,
            auth.userId,
            new Date(),
          );
        } catch (e) {
          if (e instanceof PostingError) throw ApiError.validation(e.message);
          throw e;
        }
        if (!res.reused)
          await auditRequest(
            app,
            request,
            {
              action: 'journal.submit',
              resourceType: 'journal_entry',
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
        entryId: request.params.id,
        approvalId: out.approval.id,
        status: 'approval_required' as const,
        reused: out.reused,
      };
    },
  );

  typed.get(
    '/api/v1/accounts',
    {
      schema: {
        tags: ['ledger'],
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(AccountSchema), ...errorResponses(401, 403) },
      },
      config: { permission: PERMISSIONS.JOURNAL_READ },
    },
    async (request) => app.ctx.repos.ledger.listAccounts(requireAuth(request).companyId),
  );

  typed.put(
    '/api/v1/chart-of-accounts',
    {
      schema: {
        tags: ['ledger'],
        summary:
          'Şirkətin hesablar planını yüklə (mövcud plan əvəzlənir: yeni plan yaranır və aktiv olur)',
        security: [{ bearerAuth: [] }],
        body: z.object({
          name: z.string().trim().min(1).max(200),
          standard: z.enum(['MMUS', 'MHBS']).default('MMUS'),
          accounts: z
            .array(
              z.object({
                code: z.string().regex(/^\d{3,6}$/),
                nameAz: z.string().min(1),
                nameRu: z.string().optional(),
                nameEn: z.string().optional(),
                type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense', 'off_balance']),
                parentCode: z
                  .string()
                  .regex(/^\d{3,6}$/)
                  .optional(),
              }),
            )
            .min(1)
            .max(2000),
        }),
        response: {
          200: z.object({ chartId: z.uuid(), accounts: z.number().int() }),
          ...errorResponses(401, 403, 409, 422),
        },
      },
      config: { permission: PERMISSIONS.JOURNAL_WRITE },
    },
    async (request) => {
      const auth = requireAuth(request);
      const codes = new Set<string>();
      for (const a of request.body.accounts) {
        if (codes.has(a.code)) throw ApiError.validation(`Duplicate account code ${a.code}`);
        codes.add(a.code);
      }
      for (const a of request.body.accounts)
        if (a.parentCode && !codes.has(a.parentCode))
          throw ApiError.validation(`Unknown parent account ${a.parentCode}`);
      // valideyn əvvəl yazılmalıdır
      const sorted = [...request.body.accounts].sort(
        (a, b) => (a.parentCode ? 1 : 0) - (b.parentCode ? 1 : 0),
      );
      const chartId = await app.ctx.db.tx(async (tx) => {
        const id = await createRepos(tx).ledger.importChart(
          auth.companyId,
          `${request.body.name} ${new Date().toISOString()}`,
          request.body.standard,
          sorted,
        );
        await auditRequest(
          app,
          request,
          {
            action: 'chart.import',
            resourceType: 'chart_of_accounts',
            resourceId: id,
            after: { name: request.body.name, accounts: sorted.length },
          },
          tx,
        );
        return id;
      });
      return { chartId, accounts: sorted.length };
    },
  );
}
