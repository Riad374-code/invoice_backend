import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ApiError } from '../error.js';

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** Sabit pəncərəli, yaddaşda limiter (tək instans). Çox instans üçün eyni interfeys Redis/PG ilə əvəzlənə bilər. */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, { count: number; windowStart: number }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly now: () => number = Date.now) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  check(key: string, max: number, windowSeconds: number): RateLimitDecision {
    const nowMs = this.now();
    const windowMs = windowSeconds * 1000;
    const bucket = this.buckets.get(key);
    if (!bucket || nowMs - bucket.windowStart >= windowMs) {
      this.buckets.set(key, { count: 1, windowStart: nowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (bucket.count >= max) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStart + windowMs - nowMs) / 1000)),
      };
    }
    bucket.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private sweep(): void {
    const cutoff = this.now() - 15 * 60_000;
    for (const [key, b] of this.buckets) if (b.windowStart < cutoff) this.buckets.delete(key);
  }

  close(): void {
    clearInterval(this.sweeper);
  }
}

const EXEMPT = new Set(['/admin/health', '/api/v1/admin/health']);

/** Qlobal IP üzrə limit. Login üçün ayrıca, daha sərt limit handler-də tətbiq olunur (A-01). */
export default fp(async (app: FastifyInstance) => {
  app.addHook('onRequest', async (request, reply) => {
    if (EXEMPT.has(request.url.split('?')[0] ?? '')) return;
    const { allowed, retryAfterSeconds } = app.ctx.rateLimiter.check(
      `global:${request.ip}`,
      app.ctx.config.globalRateLimitPerMinute,
      60,
    );
    if (!allowed) {
      void reply.header('retry-after', String(retryAfterSeconds));
      throw ApiError.rateLimited('Too many requests. Please slow down.');
    }
  });
});
