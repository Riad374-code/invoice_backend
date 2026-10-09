import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuditInput } from './logger.js';

/** Handler-in audit yazması: sorğuya aid actor/company/requestId avtomatik doldurulur. */
export async function auditRequest(
  app: FastifyInstance,
  request: FastifyRequest,
  entry: Omit<AuditInput, 'companyId' | 'actorId' | 'requestId'> & {
    companyId?: string;
    actorId?: string | null;
  },
  db?: import('../db/index.js').Db,
): Promise<void> {
  const companyId = entry.companyId ?? request.auth?.companyId;
  if (!companyId) throw new Error('auditRequest requires a company id');
  await app.ctx.audit.log(
    {
      ...entry,
      companyId,
      actorId: entry.actorId === undefined ? (request.auth?.userId ?? null) : entry.actorId,
      requestId: request.id,
    },
    db,
  );
  request.auditRecorded = true;
}

export async function requestAuditFallback(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<void> {
  const route = request.routeOptions.url ?? request.url.split('?')[0] ?? '';
  await auditRequest(app, request, {
    action: `http.${request.method.toLowerCase()}`,
    resourceType: 'http_route',
    resourceId: route,
    after: { params: request.params ?? null },
  });
}
