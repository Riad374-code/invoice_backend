import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ApiError } from '../error.js';
import { verifyAccessToken } from '../security/index.js';
import type { AuthUser } from '../context.js';

export interface RoutePolicy {
  method: string;
  url: string;
  public: boolean;
  permission: string | undefined;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Qeydiyyatdan keçmiş bütün route-ların giriş siyasəti (avtomatik 401/403 testi üçün). */
    routePolicies: RoutePolicy[];
  }
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) return null;
  return token;
}

/**
 * A-02: fail-closed giriş nəzarəti.
 *  - Hər route ya `config.public`, ya `config.authOnly`, ya da `config.permission` elan etməlidir;
 *    elan olunmayıbsa server HƏLƏ BOOT OLARKƏN xəta ilə dayanır.
 *  - `onRequest`-də token yoxlanır (401), icazə çatışmırsa 403.
 *  - `company_id` yalnız tokendən (sessiyadan) gəlir — heç vaxt body/query-dən.
 */
export default fp(async (app: FastifyInstance) => {
  app.decorateRequest('auth', null);
  app.decorateRequest('auditRecorded', false);
  const routePolicies: RoutePolicy[] = [];
  app.decorate('routePolicies', routePolicies);

  app.addHook('onRoute', (route) => {
    const cfg = route.config ?? {};
    for (const method of [route.method].flat()) {
      routePolicies.push({
        method: String(method),
        url: route.url,
        public: cfg.public === true,
        permission: cfg.permission,
      });
    }
    if (!cfg.public && !cfg.authOnly && !cfg.permission) {
      throw new Error(
        `Route ${String(route.method)} ${route.url} must declare config.public, config.authOnly or config.permission (A-02)`,
      );
    }
  });

  app.addHook('onRequest', async (request) => {
    if (request.is404) return;
    const cfg = request.routeOptions.config;
    if (cfg.public) return;

    const token = bearerToken(request);
    if (!token) throw ApiError.unauthenticated('Missing or malformed Authorization header');

    const result = await verifyAccessToken(token, app.ctx.config.jwtSecret);
    if (!result.ok) {
      throw ApiError.unauthenticated(
        result.reason === 'expired' ? 'Access token expired' : 'Invalid access token',
      );
    }
    const { claims } = result;
    const auth: AuthUser = {
      userId: claims.sub,
      companyId: claims.companyId,
      email: claims.email,
      roles: claims.roles,
      permissions: claims.permissions,
    };
    request.auth = auth;

    if (cfg.permission && !auth.permissions.includes(cfg.permission)) {
      throw ApiError.forbidden(`Missing required permission '${cfg.permission}'`);
    }
  });
});

/** Handler daxilində tipli giriş: auth yoxdursa (konfiq xətası) 401. */
export function requireAuth(request: FastifyRequest): AuthUser {
  if (!request.auth) throw ApiError.unauthenticated();
  return request.auth;
}
