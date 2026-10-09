import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApproval } from '../../src/domain/index.js';
import { createAccessToken, totpAt } from '../../src/security/index.js';
import { ORIGIN, PASSWORD, createTestEnv, type TestEnv } from '../helpers/app.js';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({ loginRateLimitPerMinute: 1000 });
});
afterAll(() => env.close());

const csrfHeaders = (refreshCookie: string, csrf: string) => ({
  cookie: `refresh_token=${refreshCookie}`,
  'x-csrf-token': csrf,
});

async function auditActions(companyId: string): Promise<string[]> {
  return (await env.repos.audit.listByCompany(companyId, 200)).map((e) => e.action);
}

describe('health, error envelope, OpenAPI', () => {
  it('GET /admin/health and /api/v1/admin/health are public and check the DB', async () => {
    for (const url of ['/admin/health', '/api/v1/admin/health']) {
      const res = await env.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'ok',
        service: 'lexaudit-api',
        checks: { database: 'ok', storage: 'ok' },
      });
    }
  });

  it('unknown routes use the {error:{code,message,requestId}} envelope', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/v1/nope',
      headers: { 'x-request-id': 'req_abc-1' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-request-id']).toBe('req_abc-1');
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String), requestId: 'req_abc-1' },
    });
  });

  it('generates a request id and ignores unsafe incoming ones', async () => {
    const res = await env.app.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-request-id': 'bad id\n<script>' },
    });
    expect(res.headers['x-request-id']).toMatch(/^req_[0-9a-f]{32}$/);
  });

  it('validation errors are 422 VALIDATION_FAILED; malformed JSON too', async () => {
    const bad = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'x' },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(bad.json().error.message).toContain('password');

    const malformed = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(malformed.statusCode).toBe(422);
    expect(malformed.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('serves a generated OpenAPI 3 document with the documented routes', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/auth/login',
        '/api/v1/auth/refresh',
        '/api/v1/auth/logout',
        '/api/v1/me',
        '/api/v1/approvals',
        '/api/v1/approvals/{id}/decide',
        '/api/v1/audit-events',
      ]),
    );
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
  });
});

describe('CORS (yalnız konkret origin-lər)', () => {
  it('allows the configured origin with credentials', async () => {
    const res = await env.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/me',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
  it('does not echo an unknown origin', async () => {
    const res = await env.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/me',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('A-02: every endpoint is guarded (avtomatik)', () => {
  it('fails closed: a route without an access declaration cannot be registered', async () => {
    await expect(async () => {
      env.app.get('/undeclared', async () => ({}));
    }).rejects.toThrow();
  });

  it('every non-public route → 401 without a token; every permission route → 403 without the permission', async () => {
    const policies = env.app.routePolicies.filter(
      (p) => p.method !== 'HEAD' && p.method !== 'OPTIONS',
    );
    expect(policies.length).toBeGreaterThan(5);
    const nobody = await createAccessToken(
      {
        sub: env.viewer.id,
        companyId: env.companyA,
        email: env.viewer.email,
        roles: [],
        permissions: [], // heç bir icazə
      },
      15,
      env.config.jwtSecret,
    );

    for (const p of policies) {
      const url = p.url.replace(/:[A-Za-z]+/g, () => randomUUID());
      if (p.public) continue;
      const anon = await env.app.inject({
        method: p.method as 'GET',
        url,
        payload: p.method === 'GET' ? undefined : {},
      });
      expect(anon.statusCode, `${p.method} ${p.url} without token`).toBe(401);
      expect(anon.json().error.code).toBe('UNAUTHENTICATED');

      const garbage = await env.app.inject({
        method: p.method as 'GET',
        url,
        headers: { authorization: 'Bearer not.a.jwt' },
        payload: p.method === 'GET' ? undefined : {},
      });
      expect(garbage.statusCode, `${p.method} ${p.url} with garbage token`).toBe(401);

      if (p.permission) {
        const forbidden = await env.app.inject({
          method: p.method as 'GET',
          url,
          headers: env.bearer(nobody),
          payload: p.method === 'GET' ? undefined : {},
        });
        expect(forbidden.statusCode, `${p.method} ${p.url} without ${p.permission}`).toBe(403);
        expect(forbidden.json().error.code).toBe('FORBIDDEN');
      }
    }
  });

  it('public routes are exactly the intended ones', () => {
    const publicRoutes = env.app.routePolicies
      .filter((p) => p.public && p.method !== 'HEAD')
      .map((p) => `${p.method} ${p.url}`)
      .sort();
    expect(publicRoutes).toEqual(
      [
        'GET /admin/health',
        'GET /api/v1/admin/health',
        'GET /api/v1/auth/csrf',
        'GET /api/v1/openapi.json',
        'POST /api/v1/auth/login',
        'POST /api/v1/auth/logout',
        'POST /api/v1/auth/refresh',
      ].sort(),
    );
  });

  it('rejects an expired access token with a clear message', async () => {
    const expired = await createAccessToken(
      {
        sub: env.admin.id,
        companyId: env.companyA,
        email: env.admin.email,
        roles: [],
        permissions: [],
      },
      -1,
      env.config.jwtSecret,
    );
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: env.bearer(expired),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/expired/i);
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = await createAccessToken(
      {
        sub: env.admin.id,
        companyId: env.companyB,
        email: env.admin.email,
        roles: ['admin'],
        permissions: ['audit:read'],
      },
      15,
      'some-other-secret-some-other-secret!!',
    );
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/v1/audit-events',
      headers: env.bearer(forged),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('login / me / logout', () => {
  it('login succeeds with the required cookie attributes and returns tokens', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'ADMIN@alpha.az', password: PASSWORD },
      headers: { 'user-agent': 'vitest-agent', 'x-request-id': 'req_login_1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ expiresInSeconds: 900 });
    expect(body.accessToken.split('.')).toHaveLength(3);
    expect(body.csrfToken).toMatch(/^[0-9a-f]{64}$/);

    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('refresh_token=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/api/v1/auth');
    expect(setCookie).toContain(`Max-Age=${30 * 86400}`);

    // refresh token DB-də yalnız hash kimi; ip + user agent yazılıb
    const cookie = res.cookies.find((c) => c.name === 'refresh_token')!;
    const rows = await env.db.query<{ refresh_token_hash: string; user_agent: string; ip: string }>(
      'SELECT refresh_token_hash, user_agent, ip FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [env.admin.id],
    );
    expect(rows[0]?.refresh_token_hash).not.toBe(cookie.value);
    expect(rows[0]?.user_agent).toBe('vitest-agent');
    expect(rows[0]?.ip).toBeTruthy();

    const audit = await env.repos.audit.listByCompany(env.companyA, 50);
    expect(
      audit.find((e) => e.action === 'auth.login' && e.requestId === 'req_login_1'),
    ).toBeDefined();
  });

  it('wrong password and unknown user both give the same 401', async () => {
    const wrong = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: env.viewer.email, password: 'wrong-password' },
    });
    const unknown = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@nowhere.az', password: 'wrong-password' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
    expect(await auditActions(env.companyA)).toContain('auth.login_failed');
  });

  it('suspended users cannot log in (403) only after proving the password', async () => {
    const now = new Date();
    const id = randomUUID();
    await env.repos.users.create({
      id,
      companyId: env.companyA,
      email: 'suspended@alpha.az',
      passwordHash: (await env.repos.users.findByEmail(env.admin.email))!.passwordHash,
      status: 'suspended',
      mfaSecret: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    const bad = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'suspended@alpha.az', password: 'nope' },
    });
    expect(bad.statusCode).toBe(401);
    const good = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'suspended@alpha.az', password: PASSWORD },
    });
    expect(good.statusCode).toBe(403);
  });

  it('enforces TOTP when the user has an mfa_secret', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const now = new Date();
    await env.repos.users.create({
      id: randomUUID(),
      companyId: env.companyA,
      email: 'mfa@alpha.az',
      passwordHash: (await env.repos.users.findByEmail(env.admin.email))!.passwordHash,
      status: 'active',
      mfaSecret: secret,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    const login = (mfaCode?: string) =>
      env.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'mfa@alpha.az', password: PASSWORD, mfaCode },
      });
    expect((await login()).statusCode).toBe(401);
    expect((await login('000000')).statusCode).toBe(401);
    expect((await login(totpAt(secret, Date.now()))).statusCode).toBe(200);
  });

  it('GET /me requires auth and returns tenant info from the session', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(401);
    const { accessToken } = await env.login(env.admin.email);
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: env.bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    const me = res.json();
    expect(me).toMatchObject({
      id: env.admin.id,
      email: 'admin@alpha.az',
      status: 'active',
      companyId: env.companyA,
      companyName: 'Alpha MMC',
      roles: ['admin'],
    });
    expect(me.permissions).toContain('approvals:decide');
    expect(me.permissions).toHaveLength(19);
  });

  it('access token carries the configured lifetime (A-07)', async () => {
    const { accessToken } = await env.login(env.admin.email);
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString());
    expect(payload.exp - payload.iat).toBe(15 * 60);
  });

  it('logout needs the CSRF token, revokes the session and clears the cookie', async () => {
    const { cookie, csrfToken, accessToken } = await env.login(env.viewer.email);
    const noCsrf = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: `refresh_token=${cookie}` },
    });
    expect(noCsrf.statusCode).toBe(403);

    const res = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: csrfHeaders(cookie, csrfToken),
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toMatch(/refresh_token=;.*(Max-Age=0|Expires=)/);

    const refresh = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: csrfHeaders(cookie, csrfToken),
    });
    expect(refresh.statusCode).toBe(401);
    expect(accessToken).toBeTruthy();
    expect(await auditActions(env.companyA)).toContain('auth.logout');
  });

  it('logout without any cookie is a harmless 200', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(res.statusCode).toBe(200);
  });
});

describe('refresh rotation (A-07)', () => {
  it('rotates the token, revokes the old one and issues a working access token', async () => {
    const first = await env.login(env.admin.email);

    const res = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: csrfHeaders(first.cookie, first.csrfToken),
    });
    expect(res.statusCode).toBe(200);
    const next = res.cookies.find((c) => c.name === 'refresh_token')!;
    expect(next.value).not.toBe(first.cookie);
    const body = res.json();
    expect(body.csrfToken).not.toBe(first.csrfToken);

    const me = await env.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: env.bearer(body.accessToken),
    });
    expect(me.statusCode).toBe(200);

    // yeni token işləyir
    const again = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: csrfHeaders(next.value, body.csrfToken),
    });
    expect(again.statusCode).toBe(200);
  });

  it('reuse of a rotated token is detected and kills every session of the user', async () => {
    const first = await env.login(env.approver.email);
    const rotated = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: csrfHeaders(first.cookie, first.csrfToken),
    });
    const live = rotated.cookies.find((c) => c.name === 'refresh_token')!;
    const liveCsrf = rotated.json().csrfToken as string;

    const replay = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: csrfHeaders(first.cookie, first.csrfToken),
    });
    expect(replay.statusCode).toBe(401);
    expect(await auditActions(env.companyA)).toContain('auth.refresh_reuse_detected');

    const afterTheft = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: csrfHeaders(live.value, liveCsrf),
    });
    expect(afterTheft.statusCode).toBe(401);
  });

  it('two parallel refreshes with the same token: exactly one wins', async () => {
    const { cookie, csrfToken } = await env.login(env.viewer.email);
    const fire = () =>
      env.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: csrfHeaders(cookie, csrfToken),
      });
    const codes = (await Promise.all([fire(), fire()])).map((r) => r.statusCode).sort();
    expect(codes[0]).toBe(200);
    expect(codes[1]).toBe(401);
  });

  it('requires the cookie and a valid CSRF token', async () => {
    const { cookie, csrfToken } = await env.login(env.admin.email);
    expect((await env.app.inject({ method: 'POST', url: '/api/v1/auth/refresh' })).statusCode).toBe(
      401,
    );
    const noCsrf = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `refresh_token=${cookie}` },
    });
    expect(noCsrf.statusCode).toBe(403);
    const wrongCsrf = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: csrfHeaders(cookie, 'f'.repeat(64)),
    });
    expect(wrongCsrf.statusCode).toBe(403);
    // CSRF token başqa sessiyadan götürülüb → rədd
    const other = await env.login(env.admin.email);
    const crossSession = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: csrfHeaders(cookie, other.csrfToken),
    });
    expect(crossSession.statusCode).toBe(403);
    expect(csrfToken).toBeTruthy();
  });

  it('GET /auth/csrf re-issues the CSRF token for an active cookie (after page reload)', async () => {
    const { cookie, csrfToken } = await env.login(env.admin.email);
    const ok = await env.app.inject({
      method: 'GET',
      url: '/api/v1/auth/csrf',
      headers: { cookie: `refresh_token=${cookie}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().csrfToken).toBe(csrfToken);
    expect((await env.app.inject({ method: 'GET', url: '/api/v1/auth/csrf' })).statusCode).toBe(
      401,
    );
  });

  it('rejects an expired session', async () => {
    const { cookie, csrfToken } = await env.login(env.viewer.email);
    await env.db.query(
      `UPDATE sessions SET expires_at = NOW() - interval '1 minute' WHERE user_id = $1`,
      [env.viewer.id],
    );
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: csrfHeaders(cookie, csrfToken),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('RBAC', () => {
  it('viewer is forbidden from approvals and audit but allowed on /me', async () => {
    const { accessToken } = await env.login(env.viewer.email);
    const h = env.bearer(accessToken);
    expect(
      (await env.app.inject({ method: 'GET', url: '/api/v1/me', headers: h })).statusCode,
    ).toBe(200);
    expect(
      (await env.app.inject({ method: 'GET', url: '/api/v1/approvals', headers: h })).statusCode,
    ).toBe(403);
    expect(
      (await env.app.inject({ method: 'GET', url: '/api/v1/audit-events', headers: h })).statusCode,
    ).toBe(403);
  });

  it('audit-events are tenant-scoped and limit-validated', async () => {
    const a = await env.login(env.admin.email);
    const b = await env.login(env.otherCompanyAdmin.email);
    const listA = await env.app.inject({
      method: 'GET',
      url: '/api/v1/audit-events?limit=200',
      headers: env.bearer(a.accessToken),
    });
    const listB = await env.app.inject({
      method: 'GET',
      url: '/api/v1/audit-events?limit=200',
      headers: env.bearer(b.accessToken),
    });
    expect(listA.statusCode).toBe(200);
    expect(listA.json().length).toBeGreaterThan(0);
    const idsA = new Set(listA.json().map((e: { id: string }) => e.id));
    for (const e of listB.json() as { id: string }[]) expect(idsA.has(e.id)).toBe(false);
    const bad = await env.app.inject({
      method: 'GET',
      url: '/api/v1/audit-events?limit=5000',
      headers: env.bearer(a.accessToken),
    });
    expect(bad.statusCode).toBe(422);
  });
});

describe('approvals (A-03, A-04, tenant isolation)', () => {
  async function pending(requesterId: string, companyId = env.companyA, expiresInMs = 3_600_000) {
    return env.repos.approvals.create(
      newApproval({
        companyId,
        kind: 'journal_post',
        resourceRef: `journal:${randomUUID()}`,
        payload: { amount: '100.00' },
        requesterId,
        expiresAt: new Date(Date.now() + expiresInMs),
      }),
    );
  }
  const decide = (token: string, id: string, payload: object) =>
    env.app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${id}/decide`,
      headers: env.bearer(token),
      payload,
    });

  it('lists only own-company approvals', async () => {
    const mine = await pending(env.admin.id);
    const theirs = await pending(env.otherCompanyAdmin.id, env.companyB);
    const { accessToken } = await env.login(env.admin.email);
    const res = await env.app.inject({
      method: 'GET',
      url: '/api/v1/approvals',
      headers: env.bearer(accessToken),
    });
    const ids = res.json().map((a: { id: string }) => a.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  it('A-03: requester cannot approve their own request (403) and nothing changes', async () => {
    const a = await pending(env.admin.id);
    const { accessToken } = await env.login(env.admin.email);
    const res = await decide(accessToken, a.id, { decision: 'approve' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect((await env.repos.approvals.findById(a.id))?.status).toBe('pending');
  });

  it('a different user approves; the decision is audited with before/after', async () => {
    const a = await pending(env.admin.id);
    const { accessToken } = await env.login(env.approver.email);
    const res = await decide(accessToken, a.id, { decision: 'approve', comment: 'Looks good' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'approved',
      approverId: env.approver.id,
      comment: 'Looks good',
    });

    const evt = (await env.repos.audit.listByCompany(env.companyA, 100)).find(
      (e) => e.action === 'approval.decide' && e.resourceId === a.id,
    );
    expect(evt).toMatchObject({
      actorId: env.approver.id,
      before: { status: 'pending' },
      after: { status: 'approved', approverId: env.approver.id },
    });
  });

  it('A-04: a decided approval cannot be decided again (409)', async () => {
    const a = await pending(env.admin.id);
    const { accessToken } = await env.login(env.approver.email);
    expect((await decide(accessToken, a.id, { decision: 'reject' })).statusCode).toBe(200);
    const second = await decide(accessToken, a.id, { decision: 'approve' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('CONFLICT');
    expect((await env.repos.approvals.findById(a.id))?.status).toBe('rejected');
  });

  it('parallel decisions: exactly one wins', async () => {
    const a = await pending(env.admin.id);
    const { accessToken } = await env.login(env.approver.email);
    const codes = (
      await Promise.all([
        decide(accessToken, a.id, { decision: 'approve' }),
        decide(accessToken, a.id, { decision: 'reject' }),
      ])
    )
      .map((r) => r.statusCode)
      .sort();
    expect(codes).toEqual([200, 409]);
  });

  it('an expired request is persisted as expired and answers 409', async () => {
    const a = await pending(env.admin.id, env.companyA, -1000);
    const { accessToken } = await env.login(env.approver.email);
    const res = await decide(accessToken, a.id, { decision: 'approve' });
    expect(res.statusCode).toBe(409);
    expect((await env.repos.approvals.findById(a.id))?.status).toBe('expired');
  });

  it("another company's approval is a 404, not a 403", async () => {
    const a = await pending(env.otherCompanyAdmin.id, env.companyB);
    const { accessToken } = await env.login(env.approver.email);
    const res = await decide(accessToken, a.id, { decision: 'approve' });
    expect(res.statusCode).toBe(404);
    expect((await env.repos.approvals.findById(a.id))?.status).toBe('pending');
  });

  it('validates body and id; missing approval is 404', async () => {
    const { accessToken } = await env.login(env.approver.email);
    expect((await decide(accessToken, randomUUID(), { decision: 'approve' })).statusCode).toBe(404);
    expect((await decide(accessToken, randomUUID(), { decision: 'maybe' })).statusCode).toBe(422);
    expect((await decide(accessToken, 'not-a-uuid', { decision: 'approve' })).statusCode).toBe(422);
  });

  it('company_id in the body is ignored — it always comes from the session', async () => {
    const a = await pending(env.otherCompanyAdmin.id, env.companyB);
    const { accessToken } = await env.login(env.approver.email);
    const res = await decide(accessToken, a.id, { decision: 'approve', companyId: env.companyB });
    expect(res.statusCode).toBe(404);
  });
});

describe('rate limiting (A-01)', () => {
  it('blocks repeated failed logins for the same account with 429 + Retry-After', async () => {
    const limited = await createTestEnv({ loginRateLimitPerMinute: 5 });
    try {
      const statuses: number[] = [];
      let last;
      for (let i = 0; i < 7; i++) {
        last = await limited.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'ratelimit@alpha.az', password: 'wrong' },
        });
        statuses.push(last.statusCode);
      }
      expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(statuses[5]).toBe(429);
      expect(last?.headers['retry-after']).toBeDefined();
      expect(last?.json().error.code).toBe('RATE_LIMITED');
      // başqa hesab eyni IP-dən hələ də girə bilir (cüt açar)
      const other = await limited.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: limited.viewer.email, password: PASSWORD },
      });
      expect(other.statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('global per-IP limit applies to every route except health', async () => {
    const tiny = await createTestEnv({ globalRateLimitPerMinute: 3 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++)
        codes.push((await tiny.app.inject({ method: 'GET', url: '/api/v1/me' })).statusCode);
      expect(codes).toEqual([401, 401, 401, 429, 429]);
      expect((await tiny.app.inject({ method: 'GET', url: '/admin/health' })).statusCode).toBe(200);
    } finally {
      await tiny.close();
    }
  });
});

describe('idempotency', () => {
  it('replays the stored response for the same key and rejects a different payload', async () => {
    const a = await env.repos.approvals.create(
      newApproval({
        companyId: env.companyA,
        kind: 'k',
        resourceRef: 'r',
        payload: {},
        requesterId: env.admin.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    );
    const { accessToken } = await env.login(env.approver.email);
    const send = (payload: object, key = 'idem-key-0001') =>
      env.app.inject({
        method: 'POST',
        url: `/api/v1/approvals/${a.id}/decide`,
        headers: { ...env.bearer(accessToken), 'idempotency-key': key },
        payload,
      });

    const first = await send({ decision: 'approve' });
    expect(first.statusCode).toBe(200);
    const replay = await send({ decision: 'approve' });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());

    const conflicting = await send({ decision: 'reject' });
    expect(conflicting.statusCode).toBe(422);

    // açar olmasa eyni əməliyyat 409 (artıq qərar verilib)
    const noKey = await env.app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${a.id}/decide`,
      headers: env.bearer(accessToken),
      payload: { decision: 'approve' },
    });
    expect(noKey.statusCode).toBe(409);

    const badKey = await send({ decision: 'approve' }, 'x');
    expect(badKey.statusCode).toBe(422);
  });
});

describe('A-13: failures are never reported as success', () => {
  it('health returns 503 when the database is down', async () => {
    const broken = await createTestEnv();
    await broken.db.close();
    const res = await broken.app.inject({ method: 'GET', url: '/admin/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('UPSTREAM_UNAVAILABLE');
    await broken.app.close();
  });

  it('a DB failure mid-request becomes a 500 without leaking internals', async () => {
    const { accessToken } = await env.login(env.admin.email);
    const original = env.db.query.bind(env.db);
    env.db.query = async () => {
      throw new Error('connection to server at "10.0.0.5" refused (secret-detail)');
    };
    try {
      const res = await env.app.inject({
        method: 'GET',
        url: '/api/v1/audit-events',
        headers: env.bearer(accessToken),
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe('INTERNAL');
      expect(res.body).not.toContain('secret-detail');
    } finally {
      env.db.query = original;
    }
  });
});
