import { randomUUID } from 'node:crypto';
import type { FastifyInstance, RawServerBase, RawRequestDefaultExpression } from 'fastify';
import fp from 'fastify-plugin';

export const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Gələn başlıq yalnız təhlükəsiz simvollardan ibarətdirsə qəbul edilir (log injection qarşısı). */
export function generateRequestId(req: RawRequestDefaultExpression<RawServerBase>): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  return value && SAFE_ID.test(value) ? value : `req_${randomUUID().replaceAll('-', '')}`;
}

export default fp(async (app: FastifyInstance) => {
  app.addHook('onSend', async (request, reply) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
  });
});
