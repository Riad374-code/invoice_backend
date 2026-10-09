import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditRequest } from '../audit/http.js';
import { assertLocalDate, formatAmount } from '../accounting/index.js';
import { PERMISSIONS } from '../domain/index.js';
import { ApiError, errorResponses } from '../error.js';
import { createGeneratedFile } from '../files/generated.js';
import { requireAuth } from '../plugins/auth.js';
import {
  PERIOD_RE,
  computePeriodSummary,
  summaryToCsv,
  type PeriodSummary,
} from '../vat/summary.js';

const Money = z.string();
const SummarySchema = z.object({
  period: z.string(),
  from: z.string(),
  to: z.string(),
  outputVat: Money,
  inputVat: Money,
  payable: Money,
  taxableTurnover: Money,
  exemptTurnover: Money,
  zeroRatedTurnover: Money,
  depositBalance: Money.nullable(),
  byRate: z.array(
    z.object({
      code: z.string(),
      ratePercent: z.string(),
      treatment: z.string(),
      salesNet: Money,
      salesVat: Money,
      purchaseNet: Money,
      purchaseVat: Money,
    }),
  ),
  included: z.object({ sales: z.number().int(), purchases: z.number().int() }),
  excluded: z.array(z.object({ id: z.uuid(), number: z.string(), status: z.string() })),
  blockers: z.array(z.object({ invoiceId: z.uuid(), number: z.string(), reason: z.string() })),
  complete: z.boolean(),
  explanation: z.array(z.string()),
});
const PeriodParams = z.object({ p: z.string().regex(PERIOD_RE, 'period must be YYYY-MM') });

export const summaryJson = (s: PeriodSummary) => ({
  period: s.period,
  from: s.from,
  to: s.to,
  outputVat: formatAmount(s.outputVat),
  inputVat: formatAmount(s.inputVat),
  payable: formatAmount(s.payable),
  taxableTurnover: formatAmount(s.taxableTurnover),
  exemptTurnover: formatAmount(s.exemptTurnover),
  zeroRatedTurnover: formatAmount(s.zeroRatedTurnover),
  depositBalance: s.depositBalance ? formatAmount(s.depositBalance) : null,
  byRate: s.byRate.map((b) => ({
    code: b.code,
    ratePercent: b.ratePercent,
    treatment: b.treatment,
    salesNet: formatAmount(b.salesNet),
    salesVat: formatAmount(b.salesVat),
    purchaseNet: formatAmount(b.purchaseNet),
    purchaseVat: formatAmount(b.purchaseVat),
  })),
  included: s.included,
  excluded: s.excluded,
  blockers: s.blockers,
  complete: s.blockers.length === 0 && s.excluded.length === 0,
  explanation: s.explanation,
});

export default async function vatRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/api/v1/vat/periods',
    {
      schema: {
        tags: ['vat'],
        security: [{ bearerAuth: [] }],
        response: {
          200: z.array(
            z.object({
              period: z.string(),
              status: z.string(),
              latestDraftVersion: z.number().int().nullable(),
              invoices: z.number().int(),
            }),
          ),
          ...errorResponses(401, 403),
        },
      },
      config: { permission: PERMISSIONS.VAT_READ },
    },
    async (request) => {
      const auth = requireAuth(request);
      const [known, months] = await Promise.all([
        app.ctx.repos.vat.listPeriods(auth.companyId),
        app.ctx.db.query<{ p: string; n: number }>(
          `SELECT to_char(issue_date, 'YYYY-MM') AS p, count(*)::int AS n FROM invoices WHERE company_id = $1 AND deleted_at IS NULL GROUP BY 1`,
          [auth.companyId],
        ),
      ]);
      const byPeriod = new Map(months.map((m) => [m.p, m.n]));
      const all = new Map(known.map((k) => [k.period, k]));
      for (const m of months)
        if (!all.has(m.p)) all.set(m.p, { period: m.p, status: 'open', latestVersion: null });
      return [...all.values()]
        .sort((a, b) => (a.period < b.period ? 1 : -1))
        .map((p) => ({
          period: p.period,
          status: p.status,
          latestDraftVersion: p.latestVersion,
          invoices: byPeriod.get(p.period) ?? 0,
        }));
    },
  );

  typed.get(
    '/api/v1/vat/periods/:p/summary',
    {
      schema: {
        tags: ['vat'],
        summary:
          'Dövr üzrə ƏDV yekunu (yalnız deterministik mühərrikdən; hesablanmayanlar açıq göstərilir)',
        security: [{ bearerAuth: [] }],
        params: PeriodParams,
        response: { 200: SummarySchema, ...errorResponses(401, 403, 422) },
      },
      config: { permission: PERMISSIONS.VAT_READ },
    },
    async (request) =>
      summaryJson(
        await computePeriodSummary(app.ctx.repos, requireAuth(request).companyId, request.params.p),
      ),
  );

  typed.post(
    '/api/v1/vat/periods/:p/draft-return',
    {
      schema: {
        tags: ['vat'],
        summary:
          'Bəyannamə QARALAMASI: yeni CSV fayl + vat_returns versiyası (qaimələr dəyişmir; təqdim etmir)',
        security: [{ bearerAuth: [] }],
        params: PeriodParams,
        response: {
          201: z.object({
            returnId: z.uuid(),
            version: z.number().int(),
            draftFileId: z.uuid(),
            summary: SummarySchema,
          }),
          ...errorResponses(401, 403, 409, 422),
        },
      },
      config: { permission: PERMISSIONS.VAT_WRITE },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const s = await computePeriodSummary(app.ctx.repos, auth.companyId, request.params.p);
      // Natamam rəqəmlərlə "bəyannamə" yaratmırıq (xarici valyuta məzənnəsi/dərəcə tapılmayıb)
      if (s.blockers.length)
        throw ApiError.conflict(
          `Cannot draft: ${s.blockers.length} invoice(s) are blocked (${s.blockers[0]!.reason})`,
        );
      const company = (await app.ctx.repos.companies.findById(auth.companyId))!;
      const nextVersion =
        ((await app.ctx.repos.vat.latestReturn(auth.companyId, s.period))?.version ?? 0) + 1;
      const csv = summaryToCsv(s, {
        company: company.name,
        voen: company.voen,
        generatedAt: new Date().toISOString(),
        version: nextVersion,
      });
      const file = await createGeneratedFile(
        { db: app.ctx.db, storage: app.ctx.storage },
        {
          companyId: auth.companyId,
          userId: auth.userId,
          name: `vat-return-draft-${s.period}-v${nextVersion}.csv`,
          mime: 'text/csv',
          content: Buffer.from(csv, 'utf8'),
          folder: `/vat/returns/${s.period.slice(0, 4)}`,
          tags: ['vat-draft', s.period],
          text: csv,
        },
      );
      const returnId = await app.ctx.db.tx(async (tx) => {
        const { createRepos } = await import('../db/index.js');
        const r = createRepos(tx);
        const period = await r.vat.ensurePeriod(auth.companyId, s.period);
        const id = await r.vat.addReturn({
          companyId: auth.companyId,
          periodId: period.id,
          outputVat: formatAmount(s.outputVat),
          inputVat: formatAmount(s.inputVat),
          exemptTurnover: formatAmount(s.exemptTurnover),
          zeroRatedTurnover: formatAmount(s.zeroRatedTurnover),
          payable: formatAmount(s.payable),
          depositBalance: s.depositBalance ? formatAmount(s.depositBalance) : null,
          draftFileId: file.id,
          summary: summaryJson(s),
          createdBy: auth.userId,
        });
        if (period.status === 'open') await r.vat.setPeriodStatus(period.id, 'draft');
        await auditRequest(
          app,
          request,
          {
            action: 'vat_return.draft',
            resourceType: 'vat_return',
            resourceId: id,
            after: {
              period: s.period,
              version: nextVersion,
              payable: formatAmount(s.payable),
              draftFileId: file.id,
              excluded: s.excluded.length,
            },
          },
          tx,
        );
        return id;
      });
      void reply.status(201);
      return { returnId, version: nextVersion, draftFileId: file.id, summary: summaryJson(s) };
    },
  );

  typed.post(
    '/api/v1/vat/deposit-statements',
    {
      schema: {
        tags: ['vat'],
        summary: 'ƏDV depozit hesabı çıxarışını idxal et (JSON sətirlər)',
        security: [{ bearerAuth: [] }],
        body: z.object({
          period: z.string().regex(PERIOD_RE),
          lines: z
            .array(
              z.object({
                date: z.string(),
                operation: z.enum(['top_up', 'vat_payment', 'refund', 'withdrawal', 'other']),
                amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
                reference: z.string().max(100).nullable().optional(),
                counterpartyVoen: z
                  .string()
                  .regex(/^\d{10}$/)
                  .nullable()
                  .optional(),
              }),
            )
            .min(1)
            .max(5000),
        }),
        response: {
          201: z.object({ statementId: z.uuid(), lines: z.number().int() }),
          ...errorResponses(401, 403, 422),
        },
      },
      config: { permission: PERMISSIONS.VAT_WRITE },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      for (const l of request.body.lines) {
        try {
          assertLocalDate(l.date);
        } catch {
          throw ApiError.validation(`Invalid line date "${l.date}"`);
        }
      }
      const id = await app.ctx.db.tx(async (tx) => {
        const { createRepos } = await import('../db/index.js');
        const sid = await createRepos(tx).vat.importDeposit(
          auth.companyId,
          auth.userId,
          request.body.period,
          request.body.lines,
        );
        await auditRequest(
          app,
          request,
          {
            action: 'vat_deposit.import',
            resourceType: 'vat_deposit_statement',
            resourceId: sid,
            after: { period: request.body.period, lines: request.body.lines.length },
          },
          tx,
        );
        return sid;
      });
      void reply.status(201);
      return { statementId: id, lines: request.body.lines.length };
    },
  );

  typed.get(
    '/api/v1/tax-calendar',
    {
      schema: {
        tags: ['vat'],
        summary: 'Vergi təqvimi (son tarixlər bazadadır, kodda yox)',
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          from: z.string().optional(),
          to: z.string().optional(),
          taxType: z.string().optional(),
        }),
        response: {
          200: z.array(
            z.object({
              taxType: z.string(),
              period: z.string(),
              dueDate: z.string(),
              legalSourceId: z.uuid().nullable(),
            }),
          ),
          ...errorResponses(401, 403, 422),
        },
      },
      config: { permission: PERMISSIONS.VAT_READ },
    },
    async (request) => {
      for (const d of [request.query.from, request.query.to])
        if (d !== undefined) {
          try {
            assertLocalDate(d);
          } catch {
            throw ApiError.validation('from/to must be YYYY-MM-DD');
          }
        }
      return app.ctx.repos.vat.calendar(request.query);
    },
  );
}
