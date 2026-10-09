import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { Histogram, Registry, collectDefaultMetrics } from 'prom-client';

declare module 'fastify' {
  interface FastifyInstance {
    metrics: { registry: Registry };
  }
  interface FastifyRequest {
    metricsStart?: bigint;
  }
}

/** Prometheus metrikləri. İnstansa məxsus Registry (testlərdə təkrar qeydiyyat problemi yoxdur). */
export default fp(async (app: FastifyInstance) => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  app.decorate('metrics', { registry });
  app.addHook('onRequest', async (request) => {
    request.metricsStart = process.hrtime.bigint();
  });
  app.addHook('onResponse', async (request, reply) => {
    if (request.metricsStart === undefined) return;
    const seconds = Number(process.hrtime.bigint() - request.metricsStart) / 1e9;
    // Marşrut şablonu (cardinality üçün); uyğunlaşmayan sorğular "unmatched"
    const route = request.is404 ? 'unmatched' : (request.routeOptions.url ?? 'unmatched');
    duration.observe({ method: request.method, route, status: String(reply.statusCode) }, seconds);
  });
});
