import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { requestAuditFallback } from '../audit/http.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * "Bütün yazma əməliyyatları audit_events-də görünür" (§16) üçün təhlükəsizlik toru:
 * autentifikasiyalı yazma sorğusu 2xx ilə bitib və handler özü audit yazmayıbsa, ümumi
 * `http.<METHOD>` hadisəsi yazılır. Yazılmasa cavab 5xx olur (A-13).
 */
export default fp(async (app: FastifyInstance) => {
  app.addHook('onSend', async (request, reply, payload) => {
    if (
      !WRITE_METHODS.has(request.method) ||
      !request.auth ||
      request.auditRecorded ||
      request.routeOptions.config.skipAudit ||
      reply.statusCode < 200 ||
      reply.statusCode >= 300
    ) {
      return payload;
    }
    await requestAuditFallback(app, request);
    request.auditRecorded = true;
    return payload;
  });
});
