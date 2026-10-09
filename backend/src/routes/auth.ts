import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { auditRequest } from '../audit/http.js';
import type { Repos } from '../db/index.js';
import { createRepos } from '../db/index.js';
import { isSessionActive, type Session, type User } from '../domain/index.js';
import { ApiError, errorResponses } from '../error.js';
import { requireAuth } from '../plugins/auth.js';
import {
  createAccessToken,
  createCsrfToken,
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  verifyCsrfToken,
  verifyPassword,
  verifyTotp,
} from '../security/index.js';

const REFRESH_COOKIE = 'refresh_token';
const COOKIE_PATH = '/api/v1/auth';
export const CSRF_HEADER = 'x-csrf-token';

const AuthResponseSchema = z.object({
  accessToken: z.string(),
  csrfToken: z.string(),
  expiresInSeconds: z.number().int(),
});

const LoginBodySchema = z.object({
  email: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(1024),
  mfaCode: z.string().trim().max(10).optional(),
});

const MeSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  status: z.enum(['pending', 'active', 'suspended']),
  companyId: z.uuid(),
  companyName: z.string().nullable(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
});

export default async function authRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { config } = app.ctx;

  // Naməlum istifadəçidə də argon2 işləsin ki, cavab müddəti hesabın mövcudluğunu açmasın.
  const dummyHash = await hashPassword(randomUUID());

  function setRefreshCookie(reply: FastifyReply, token: string) {
    void reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      // Secure: brauzerlər http://localhost-u istisna etsə də, Safari etmir → yalnız dev-də söndürülür
      secure: config.appEnv !== 'development',
      sameSite: 'strict',
      path: COOKIE_PATH,
      maxAge: config.refreshTokenTtlDays * 86_400,
    });
  }

  function clearRefreshCookie(reply: FastifyReply) {
    void reply.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: config.appEnv !== 'development',
      sameSite: 'strict',
      path: COOKIE_PATH,
    });
  }

  async function issueTokens(user: User, repos: Repos) {
    const [roles, perms] = await Promise.all([
      repos.roles.getUserRoles(user.id),
      repos.roles.getUserPermissions(user.id),
    ]);
    const accessToken = await createAccessToken(
      {
        sub: user.id,
        companyId: user.companyId,
        email: user.email,
        roles: roles.map((r) => r.name),
        permissions: perms.map((p) => p.code),
      },
      config.accessTokenTtlMinutes,
      config.jwtSecret,
    );
    return accessToken;
  }

  function newSession(
    user: User,
    refreshToken: string,
    request: FastifyRequest,
    now: Date,
  ): Session {
    return {
      id: randomUUID(),
      companyId: user.companyId,
      userId: user.id,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(now.getTime() + config.refreshTokenTtlDays * 86_400_000),
      revokedAt: null,
      ip: request.ip,
      userAgent: request.headers['user-agent']?.slice(0, 512) ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  function authBody(accessToken: string, refreshToken: string) {
    return {
      accessToken,
      csrfToken: createCsrfToken(refreshToken, config.csrfSecret),
      expiresInSeconds: config.accessTokenTtlMinutes * 60,
    };
  }

  /** Cookie ilə autentifikasiya olunan endpoint-lər üçün: cookie + CSRF başlığı. */
  function readRefreshCookie(request: FastifyRequest): string | undefined {
    const v = request.cookies[REFRESH_COOKIE];
    return v && /^[0-9a-f]{64}$/.test(v) ? v : undefined;
  }

  function assertCsrf(request: FastifyRequest, refreshToken: string) {
    const header = request.headers[CSRF_HEADER];
    const token = Array.isArray(header) ? header[0] : header;
    if (!verifyCsrfToken(token, refreshToken, config.csrfSecret)) {
      throw ApiError.forbidden('Missing or invalid CSRF token');
    }
  }

  // ---------------------------------------------------------------- POST /auth/login
  typed.post(
    '/api/v1/auth/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Email + parol ilə giriş; refresh token HttpOnly cookie-də verilir',
        body: LoginBodySchema,
        response: { 200: AuthResponseSchema, ...errorResponses(401, 403, 422, 429) },
      },
      config: { public: true, skipAudit: true },
    },
    async (request, reply) => {
      const { password, mfaCode } = request.body;
      const email = request.body.email.toLowerCase();

      // A-01: login rate limit (IP+email və təkcə IP)
      const perPair = app.ctx.rateLimiter.check(
        `login:${request.ip}:${email}`,
        config.loginRateLimitPerMinute,
        60,
      );
      const perIp = app.ctx.rateLimiter.check(
        `login-ip:${request.ip}`,
        config.loginRateLimitPerMinute * 5,
        60,
      );
      if (!perPair.allowed || !perIp.allowed) {
        void reply.header(
          'retry-after',
          String(Math.max(perPair.retryAfterSeconds, perIp.retryAfterSeconds)),
        );
        throw ApiError.rateLimited(
          'Too many login attempts. Please wait a minute before retrying.',
        );
      }

      const { repos, db } = app.ctx;
      const user = await repos.users.findByEmail(email);
      const passwordOk = await verifyPassword(password, user?.passwordHash ?? dummyHash);
      if (!user || !passwordOk) {
        if (user) {
          await auditRequest(app, request, {
            companyId: user.companyId,
            actorId: user.id,
            action: 'auth.login_failed',
            resourceType: 'user',
            resourceId: user.id,
            after: { reason: 'invalid_password' },
          });
        }
        throw ApiError.unauthenticated('Invalid credentials');
      }
      if (user.status !== 'active') {
        throw ApiError.forbidden('User account is not active');
      }
      if (user.mfaSecret && !(mfaCode && verifyTotp(user.mfaSecret, mfaCode))) {
        await auditRequest(app, request, {
          companyId: user.companyId,
          actorId: user.id,
          action: 'auth.login_failed',
          resourceType: 'user',
          resourceId: user.id,
          after: { reason: mfaCode ? 'invalid_mfa_code' : 'mfa_required' },
        });
        throw ApiError.unauthenticated(mfaCode ? 'Invalid MFA code' : 'MFA code required');
      }

      const now = new Date();
      const refreshToken = generateRefreshToken();
      const session = newSession(user, refreshToken, request, now);
      await db.tx(async (tx) => {
        await createRepos(tx).sessions.create(session);
        await auditRequest(
          app,
          request,
          {
            companyId: user.companyId,
            actorId: user.id,
            action: 'auth.login',
            resourceType: 'session',
            resourceId: session.id,
            after: { userId: user.id, email: user.email },
          },
          tx,
        );
      });

      const accessToken = await issueTokens(user, repos);
      setRefreshCookie(reply, refreshToken);
      return authBody(accessToken, refreshToken);
    },
  );

  // ---------------------------------------------------------------- POST /auth/refresh
  typed.post(
    '/api/v1/auth/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Refresh token rotasiyası (cookie + X-CSRF-Token)',
        response: { 200: AuthResponseSchema, ...errorResponses(401, 403, 429) },
      },
      config: { public: true, skipAudit: true },
    },
    async (request, reply) => {
      const refreshToken = readRefreshCookie(request);
      if (!refreshToken) throw ApiError.unauthenticated('Missing refresh token cookie');
      assertCsrf(request, refreshToken);

      const { repos, db } = app.ctx;
      const hash = hashRefreshToken(refreshToken);
      const now = new Date();
      const old = await repos.sessions.findByHash(hash);
      if (!old) throw ApiError.unauthenticated('Invalid refresh token');

      if (old.revokedAt) {
        // Revoke olunmuş token təkrar təqdim edilib → oğurlanma ehtimalı: istifadəçinin bütün sessiyalarını bağla.
        const revoked = await repos.sessions.revokeAllForUser(old.userId, now);
        await auditRequest(app, request, {
          companyId: old.companyId,
          actorId: old.userId,
          action: 'auth.refresh_reuse_detected',
          resourceType: 'session',
          resourceId: old.id,
          after: { revokedSessions: revoked },
        });
        clearRefreshCookie(reply);
        throw ApiError.unauthenticated('Refresh token has been revoked');
      }
      if (!isSessionActive(old, now)) throw ApiError.unauthenticated('Refresh token expired');

      const user = await repos.users.findById(old.userId);
      if (!user) throw ApiError.unauthenticated('User no longer exists');
      if (user.status !== 'active') throw ApiError.forbidden('User account is not active');

      const newToken = generateRefreshToken();
      const session = newSession(user, newToken, request, now);
      // A-07: rotation — köhnə sessiya atomik revoke olunur; paralel ikinci istifadə uğursuz olur
      await db.tx(async (tx) => {
        const txRepos = createRepos(tx);
        if (!(await txRepos.sessions.revoke(old.id, now))) {
          throw ApiError.unauthenticated('Refresh token already used');
        }
        await txRepos.sessions.create(session);
        await auditRequest(
          app,
          request,
          {
            companyId: user.companyId,
            actorId: user.id,
            action: 'auth.refresh',
            resourceType: 'session',
            resourceId: session.id,
            before: { sessionId: old.id },
            after: { sessionId: session.id },
          },
          tx,
        );
      });

      const accessToken = await issueTokens(user, repos);
      setRefreshCookie(reply, newToken);
      return authBody(accessToken, newToken);
    },
  );

  // ---------------------------------------------------------------- GET /auth/csrf
  typed.get(
    '/api/v1/auth/csrf',
    {
      schema: {
        tags: ['auth'],
        summary: 'Mövcud refresh sessiyası üçün CSRF token (səhifə yenilənəndən sonra)',
        response: { 200: z.object({ csrfToken: z.string() }), ...errorResponses(401) },
      },
      config: { public: true, skipAudit: true },
    },
    async (request) => {
      const refreshToken = readRefreshCookie(request);
      if (!refreshToken) throw ApiError.unauthenticated('Missing refresh token cookie');
      const session = await app.ctx.repos.sessions.findActiveByHash(
        hashRefreshToken(refreshToken),
        new Date(),
      );
      if (!session) throw ApiError.unauthenticated('Invalid or expired refresh token');
      return { csrfToken: createCsrfToken(refreshToken, config.csrfSecret) };
    },
  );

  // ---------------------------------------------------------------- POST /auth/logout
  typed.post(
    '/api/v1/auth/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Sessiyanı revoke edir və cookie-ni silir',
        response: { 200: z.object({ status: z.literal('ok') }), ...errorResponses(403) },
      },
      config: { public: true, skipAudit: true },
    },
    async (request, reply) => {
      const refreshToken = readRefreshCookie(request);
      if (refreshToken) {
        assertCsrf(request, refreshToken);
        const now = new Date();
        const session = await app.ctx.repos.sessions.findActiveByHash(
          hashRefreshToken(refreshToken),
          now,
        );
        if (session) {
          await app.ctx.db.tx(async (tx) => {
            await createRepos(tx).sessions.revoke(session.id, now);
            await auditRequest(
              app,
              request,
              {
                companyId: session.companyId,
                actorId: session.userId,
                action: 'auth.logout',
                resourceType: 'session',
                resourceId: session.id,
              },
              tx,
            );
          });
        }
      }
      clearRefreshCookie(reply);
      return { status: 'ok' as const };
    },
  );

  // ---------------------------------------------------------------- GET /me
  typed.get(
    '/api/v1/me',
    {
      schema: {
        tags: ['auth'],
        summary: 'Cari istifadəçi, şirkət, rollar və icazələr',
        security: [{ bearerAuth: [] }],
        response: { 200: MeSchema, ...errorResponses(401, 404) },
      },
      config: { authOnly: true },
    },
    async (request) => {
      const auth = requireAuth(request);
      const user = await app.ctx.repos.users.findById(auth.userId);
      if (!user || user.companyId !== auth.companyId) throw ApiError.notFound('User not found');
      const company = await app.ctx.repos.companies.findById(auth.companyId);
      return {
        id: user.id,
        email: user.email,
        status: user.status,
        companyId: auth.companyId,
        companyName: company?.name ?? null,
        roles: auth.roles,
        permissions: auth.permissions,
      };
    },
  );
}
