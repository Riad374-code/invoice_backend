import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditRequest } from '../audit/http.js';
import { PERMISSIONS } from '../domain/index.js';
import { ApiError, errorResponses } from '../error.js';
import { requireAuth } from '../plugins/auth.js';

const FindingSchema = z.object({
  id: z.uuid(),
  sourceKind: z.enum(['news', 'legislation_version']),
  sourceId: z.uuid(),
  affectedResourceType: z.enum(['file', 'audit']),
  affectedResourceId: z.uuid(),
  score: z.string(),
  explanation: z.string(),
  evidence: z.unknown(),
  status: z.enum(['new', 'seen', 'dismissed', 'actioned']),
  createdAt: z.string(),
});
const NotificationSchema = z.object({
  id: z.uuid(),
  seq: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  refType: z.string().nullable(),
  refId: z.uuid().nullable(),
  read: z.boolean(),
  createdAt: z.string(),
});
const IdParams = z.object({ id: z.uuid() });

export default async function impactRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const fin = (f: Awaited<ReturnType<typeof app.ctx.repos.impact.listFindings>>[number]) => ({
    ...f,
    createdAt: f.createdAt.toISOString(),
  });

  typed.get(
    '/api/v1/impact-findings',
    {
      schema: {
        tags: ['impact'],
        summary: 'Şirkətin sənədlərinə təsir edə bilən yeni xəbər/qanun dəyişiklikləri',
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          status: z.enum(['new', 'seen', 'dismissed', 'actioned']).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        }),
        response: { 200: z.array(FindingSchema), ...errorResponses(401, 403, 422) },
      },
      config: { permission: PERMISSIONS.IMPACT_READ },
    },
    async (request) =>
      (await app.ctx.repos.impact.listFindings(requireAuth(request).companyId, request.query)).map(
        fin,
      ),
  );

  typed.put(
    '/api/v1/impact-findings/:id/status',
    {
      schema: {
        tags: ['impact'],
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: z.object({ status: z.enum(['seen', 'dismissed', 'actioned']) }),
        response: { 200: FindingSchema, ...errorResponses(401, 403, 404, 422) },
      },
      config: { permission: PERMISSIONS.IMPACT_WRITE },
    },
    async (request) => {
      const auth = requireAuth(request);
      const f = await app.ctx.repos.impact.setFindingStatus(
        auth.companyId,
        request.params.id,
        request.body.status,
      );
      if (!f) throw ApiError.notFound('Finding not found');
      await auditRequest(app, request, {
        action: 'impact.status',
        resourceType: 'impact_finding',
        resourceId: f.id,
        after: { status: f.status },
      });
      return fin(f);
    },
  );

  typed.get(
    '/api/v1/notifications',
    {
      schema: {
        tags: ['impact'],
        summary: 'Dashboard bildirişləri (polling: `afterSeq` ilə yalnız yeniləri al)',
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          unreadOnly: z.stringbool().default(false),
          afterSeq: z.string().regex(/^\d+$/).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        }),
        response: {
          200: z.object({ unreadCount: z.number().int(), items: z.array(NotificationSchema) }),
          ...errorResponses(401, 403, 422),
        },
      },
      config: { permission: PERMISSIONS.IMPACT_READ },
    },
    async (request) => {
      const auth = requireAuth(request);
      const [items, unreadCount] = await Promise.all([
        app.ctx.repos.impact.listNotifications(auth.userId, request.query),
        app.ctx.repos.impact.unreadCount(auth.userId),
      ]);
      return {
        unreadCount,
        items: items.map((n) => ({
          id: n.id,
          seq: n.seq,
          kind: n.kind,
          title: n.title,
          body: n.body,
          refType: n.refType,
          refId: n.refId,
          read: n.readAt !== null,
          createdAt: n.createdAt.toISOString(),
        })),
      };
    },
  );

  typed.put(
    '/api/v1/notifications/:id/read',
    {
      schema: {
        tags: ['impact'],
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          200: z.object({ updated: z.number().int() }),
          ...errorResponses(401, 403, 422),
        },
      },
      config: { permission: PERMISSIONS.IMPACT_READ, skipAudit: true },
    },
    async (request) => ({
      updated: await app.ctx.repos.impact.markRead(
        requireAuth(request).userId,
        request.params.id,
        new Date(),
      ),
    }),
  );

  typed.post(
    '/api/v1/notifications/read-all',
    {
      schema: {
        tags: ['impact'],
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ updated: z.number().int() }), ...errorResponses(401, 403) },
      },
      config: { permission: PERMISSIONS.IMPACT_READ, skipAudit: true },
    },
    async (request) => ({
      updated: await app.ctx.repos.impact.markRead(requireAuth(request).userId, null, new Date()),
    }),
  );
}
