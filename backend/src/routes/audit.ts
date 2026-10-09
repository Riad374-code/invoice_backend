import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PERMISSIONS } from '../domain/index.js';
import { errorResponses } from '../error.js';
import { requireAuth } from '../plugins/auth.js';

const AuditEventSchema = z.object({
  id: z.uuid(),
  actorId: z.uuid().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  requestId: z.string(),
  createdAt: z.string(),
});

export default async function auditRoutes(app: FastifyInstance) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/v1/audit-events',
    {
      schema: {
        tags: ['audit'],
        security: [{ bearerAuth: [] }],
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: z.array(AuditEventSchema), ...errorResponses(401, 403, 422) },
      },
      config: { permission: PERMISSIONS.AUDIT_READ },
    },
    async (request) => {
      const auth = requireAuth(request);
      const events = await app.ctx.audit.list(auth.companyId, request.query.limit);
      return events.map((e) => ({
        id: e.id,
        actorId: e.actorId,
        action: e.action,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        before: e.before,
        after: e.after,
        requestId: e.requestId,
        createdAt: e.createdAt.toISOString(),
      }));
    },
  );
}
