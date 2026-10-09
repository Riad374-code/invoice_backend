import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ApiError, errorResponses } from '../error.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const HealthSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  timestamp: z.string(),
  checks: z.object({ database: z.literal('ok'), storage: z.literal('ok') }),
});

export default async function adminRoutes(app: FastifyInstance) {
  const handler = async () => {
    try {
      await app.ctx.db.ping();
    } catch (err) {
      // A-13: DB düşübsə saxta "ok" qaytarmırıq
      app.log.error({ err }, 'health check: database unreachable');
      throw ApiError.upstream('Database is unavailable');
    }
    try {
      await app.ctx.storage.ping();
    } catch (err) {
      app.log.error({ err }, 'health check: object storage unreachable');
      throw ApiError.upstream('Object storage is unavailable');
    }
    return {
      status: 'ok' as const,
      service: 'lexaudit-api',
      version: pkg.version,
      timestamp: new Date().toISOString(),
      checks: { database: 'ok' as const, storage: 'ok' as const },
    };
  };

  const opts = {
    schema: {
      tags: ['admin'],
      summary: 'Liveness + database readiness',
      response: { 200: HealthSchema, ...errorResponses(503) },
    },
    config: { public: true, skipAudit: true },
  } as const;

  // docker-compose / load balancer üçün prefikssiz, API üçün /api/v1 altında
  app.withTypeProvider<ZodTypeProvider>().get('/admin/health', opts, handler);
  app.withTypeProvider<ZodTypeProvider>().get('/api/v1/admin/health', opts, handler);
}
