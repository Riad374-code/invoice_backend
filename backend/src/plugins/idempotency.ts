import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ApiError } from '../error.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const TTL_MS = 24 * 60 * 60 * 1000;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

type Entry =
  | { state: 'in_progress'; fingerprint: string; expires: number }
  | {
      state: 'done';
      fingerprint: string;
      expires: number;
      statusCode: number;
      payload: string | Buffer;
      contentType: string | undefined;
    };

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyScope?: string;
  }
}

/**
 * `Idempotency-Key` ilə yazma sorğularını təkrar-təhlükəsiz edir (yaddaşda, tək instans).
 *  - Eyni açar + eyni sorğu → saxlanmış cavab təkrarlanır (`idempotent-replayed: true`).
 *  - Eyni açar + fərqli sorğu → 422; hələ icra olunan sorğu → 409.
 *  - 5xx cavab saxlanmır (təkrar cəhd mümkün olsun).
 *  Açar istifadəçiyə (yoxsa IP-yə) bağlıdır — başqa tenant-ın cavabı sızmaz.
 */
export default fp(async (app: FastifyInstance) => {
  const store = new Map<string, Entry>();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of store) if (e.expires < now) store.delete(k);
  }, 5 * 60_000);
  sweeper.unref();
  app.addHook('onClose', async () => clearInterval(sweeper));

  app.addHook('preHandler', async (request, reply) => {
    if (!WRITE_METHODS.has(request.method)) return;
    const raw = request.headers[IDEMPOTENCY_HEADER];
    if (raw === undefined) return;
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key || !KEY_PATTERN.test(key)) {
      throw ApiError.validation('Idempotency-Key must be 8-128 characters of [A-Za-z0-9._:-]');
    }

    const route = request.routeOptions.url ?? request.url;
    const scope = `${request.auth?.userId ?? request.ip}|${request.method}|${route}|${key}`;
    const fingerprint = createHash('sha256')
      // multipart yüklənmələrində body hələ oxunmayıb → content-length ilə (boundary hər sorğuda fərqlidir)
      .update(
        JSON.stringify([
          request.url,
          request.body ?? null,
          request.body === undefined ? (request.headers['content-length'] ?? null) : null,
        ]),
      )
      .digest('hex');

    const existing = store.get(scope);
    if (existing && existing.expires > Date.now()) {
      if (existing.fingerprint !== fingerprint) {
        throw ApiError.validation('Idempotency-Key was already used with a different request');
      }
      if (existing.state === 'in_progress') {
        throw ApiError.conflict('A request with this Idempotency-Key is still in progress');
      }
      void reply.header('idempotent-replayed', 'true');
      if (existing.contentType) void reply.header('content-type', existing.contentType);
      return reply.status(existing.statusCode).send(existing.payload);
    }

    store.set(scope, { state: 'in_progress', fingerprint, expires: Date.now() + TTL_MS });
    request.idempotencyScope = scope;
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const scope = request.idempotencyScope;
    if (!scope) return payload;
    const entry = store.get(scope);
    if (!entry || entry.state !== 'in_progress') return payload;
    if (reply.statusCode >= 500 || (typeof payload !== 'string' && !Buffer.isBuffer(payload))) {
      store.delete(scope);
      return payload;
    }
    const ct = reply.getHeader('content-type');
    store.set(scope, {
      state: 'done',
      fingerprint: entry.fingerprint,
      expires: Date.now() + TTL_MS,
      statusCode: reply.statusCode,
      payload,
      contentType: typeof ct === 'string' ? ct : undefined,
    });
    return payload;
  });
});
