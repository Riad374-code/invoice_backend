import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditRequest } from '../audit/http.js';
import { createRepos } from '../db/index.js';
import {
  APPROVAL_STATUSES,
  PERMISSIONS,
  approve,
  expireIfDue,
  reject,
  type Approval,
} from '../domain/index.js';
import { ApiError, errorResponses } from '../error.js';
import { requireAuth } from '../plugins/auth.js';
import { PostingError, postEntry } from '../ledger/service.js';
import { executeApprovedToolRun } from '../agent/gateway.js';
import { SourceAccumulator } from '../agent/tools.js';
import { hybridSearch } from '../rag/search.js';

const ApprovalSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  resourceRef: z.string(),
  requesterId: z.uuid(),
  approverId: z.uuid().nullable(),
  status: z.enum(APPROVAL_STATUSES),
  expiresAt: z.string(),
  decidedAt: z.string().nullable(),
  comment: z.string().nullable(),
  createdAt: z.string(),
  /** `tool:*` təsdiqlərində: təsdiqdən sonra alətin icra nəticəsi */
  execution: z
    .object({ status: z.enum(['succeeded', 'failed', 'skipped']), message: z.string() })
    .optional(),
});

const toResponse = (a: Approval) => ({
  id: a.id,
  kind: a.kind,
  resourceRef: a.resourceRef,
  requesterId: a.requesterId,
  approverId: a.approverId,
  status: a.status,
  expiresAt: a.expiresAt.toISOString(),
  decidedAt: a.decidedAt?.toISOString() ?? null,
  comment: a.comment,
  createdAt: a.createdAt.toISOString(),
});

export default async function approvalRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/api/v1/approvals',
    {
      schema: {
        tags: ['approvals'],
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(ApprovalSchema), ...errorResponses(401, 403) },
      },
      config: { permission: PERMISSIONS.APPROVALS_READ },
    },
    async (request) => {
      const auth = requireAuth(request);
      // Tenant izolyasiyası: həmişə sessiyadakı company_id ilə
      const items = await app.ctx.repos.approvals.listByCompany(auth.companyId);
      return items.map(toResponse);
    },
  );

  typed.post(
    '/api/v1/approvals/:id/decide',
    {
      schema: {
        tags: ['approvals'],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          decision: z.enum(['approve', 'reject']),
          comment: z.string().trim().max(2000).optional(),
        }),
        response: { 200: ApprovalSchema, ...errorResponses(401, 403, 404, 409, 422) },
      },
      config: { permission: PERMISSIONS.APPROVALS_DECIDE },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { id } = request.params;
      const { decision, comment } = request.body;

      const outcome = await app.ctx.db.tx(async (tx) => {
        const repos = createRepos(tx);
        // FOR UPDATE: paralel iki qərar yarışını sıraya salır (A-04)
        const current = await repos.approvals.findById(id, { forUpdate: true });
        // Başqa şirkətin sorğusu → 404 (mövcudluğu açıqlanmır)
        if (!current || current.companyId !== auth.companyId) {
          throw ApiError.notFound(`Approval ${id} not found`);
        }

        const now = new Date();
        const expired = expireIfDue(current, now);
        if (expired !== current) {
          // Vaxtı keçib: statusu `expired` olaraq SAXLA (rollback olunmasın), sonra 409 ver
          await repos.approvals.saveDecision(expired);
          await auditRequest(
            app,
            request,
            {
              action: 'approval.expire',
              resourceType: 'approval',
              resourceId: id,
              before: { status: current.status },
              after: { status: 'expired' },
            },
            tx,
          );
          return { expired: true as const };
        }

        // A-03 / A-04 domain state machine-də yoxlanır
        const decided =
          decision === 'approve'
            ? approve(current, auth.userId, comment ?? null, now)
            : reject(current, auth.userId, comment ?? null, now);
        await repos.approvals.saveDecision(decided);

        // Jurnal yazılışı: təsdiq və post EYNİ tranzaksiyadadır — post uğursuz olarsa qərar da geri qaytarılır
        if (decided.kind === 'journal_post') {
          const entryId = (decided.payload as { entryId?: string } | null)?.entryId;
          if (!entryId) throw ApiError.internal('Approval payload has no entryId');
          if (decided.status === 'approved') {
            try {
              await postEntry(repos, auth.companyId, entryId, auth.userId, now);
            } catch (e) {
              if (e instanceof PostingError) throw ApiError.validation(e.message);
              throw e;
            }
          } else {
            await repos.ledger.setApproval(auth.companyId, entryId, null); // yenidən təsdiqə göndərilə bilər
          }
        }
        await auditRequest(
          app,
          request,
          {
            action: 'approval.decide',
            resourceType: 'approval',
            resourceId: id,
            before: { status: current.status },
            after: { status: decided.status, approverId: auth.userId, comment: comment ?? null },
          },
          tx,
        );
        return { expired: false as const, approval: decided };
      });

      if (outcome.expired) throw ApiError.conflict('Approval has expired');
      const decided = outcome.approval;
      if (!decided.kind.startsWith('tool:')) return toResponse(decided);

      // Agent təklifi: təsdiqdən SONRA, saxlanılmış (artıq validasiya olunmuş) arqumentlərlə icra
      if (decided.status === 'approved') {
        const execution = await executeApprovedToolRun(
          {
            registry: app.ctx.tools,
            repos: app.ctx.repos,
            buildCtx: (base) => ({
              ...base,
              repos: app.ctx.repos,
              db: app.ctx.db,
              sources: new SourceAccumulator(),
              models: app.ctx.models,
              now: new Date(),
              search: (req) =>
                hybridSearch(
                  { repos: app.ctx.repos, embedder: app.ctx.embedder, reranker: app.ctx.reranker },
                  { ...req, companyId: base.companyId },
                ),
            }),
          },
          decided,
          request.id,
        );
        await auditRequest(app, request, {
          action: 'approval.execute',
          resourceType: 'approval',
          resourceId: decided.id,
          after: { tool: decided.kind, status: execution.status },
        });
        return { ...toResponse(decided), execution };
      }
      const run = await app.ctx.repos.assistant.findRunByApproval(decided.id);
      if (run && run.status === 'approval_required') {
        await app.ctx.repos.assistant.finishToolRun(run.id, {
          status: 'rejected',
          validatedArgs: run.validatedArgs,
          rejectReason: 'approval_rejected',
          resultSummary: 'Approval rejected',
          approvalId: decided.id,
          durationMs: 0,
          idempotencyKey: run.idempotencyKey,
        });
      }
      return toResponse(decided);
    },
  );
}
