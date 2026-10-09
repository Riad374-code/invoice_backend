import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, PASSWORD, type TestEnv } from '../helpers/app.js';

let env: TestEnv;
let admin: string;
let viewer: string;
let other: string;
const call = (m: 'GET' | 'POST' | 'PUT' | 'PATCH', t: string, url: string, payload?: object) =>
  env.app.inject({ method: m, url, headers: env.bearer(t), ...(payload ? { payload } : {}) });

beforeAll(async () => {
  env = await createTestEnv({ loginRateLimitPerMinute: 1000 });
  admin = (await env.login(env.admin.email)).accessToken;
  viewer = (await env.login(env.viewer.email)).accessToken;
  other = (await env.login(env.otherCompanyAdmin.email)).accessToken;
  await env.db.query(`UPDATE companies SET is_platform = TRUE WHERE id = $1`, [env.companyA]);
});
afterAll(() => env.close());

describe('users & roles: no privilege escalation', () => {
  it('viewer cannot manage users; admin can create and suspend', async () => {
    expect((await call('GET', viewer, '/api/v1/admin/users')).statusCode).toBe(403);
    const roles = (await call('GET', admin, '/api/v1/admin/roles')).json() as Array<{
      id: string;
      name: string;
    }>;
    const viewerRole = roles.find((r) => r.name === 'viewer')!;
    const res = await call('POST', admin, '/api/v1/admin/users', {
      email: 'new.user@test.az',
      password: PASSWORD + 'xx',
      roleIds: [viewerRole.id],
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const sus = await call('PATCH', admin, `/api/v1/admin/users/${id}`, { status: 'suspended' });
    expect(sus.json().status).toBe('suspended');
    // self-suspend and tenant isolation
    expect(
      (await call('PATCH', admin, `/api/v1/admin/users/${env.admin.id}`, { status: 'suspended' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call('PATCH', other, `/api/v1/admin/users/${id}`, { status: 'active' })).statusCode,
    ).toBe(404);
  });

  it('cannot grant permissions the caller does not hold', async () => {
    // a custom role holding users:write only
    const create = await call('POST', admin, '/api/v1/admin/roles', {
      name: 'user-manager',
      permissions: ['users:read', 'users:write'],
    });
    expect(create.statusCode).toBe(201);
    const roleId = create.json().id as string;
    await env.repos.roles.assignRoleToUser(env.viewer.id, roleId);
    const mgr = (await env.login(env.viewer.email)).accessToken;
    const roles = (await call('GET', admin, '/api/v1/admin/roles')).json() as Array<{
      id: string;
      name: string;
    }>;
    const adminRole = roles.find((r) => r.name === 'admin')!;
    const res = await call('PUT', mgr, `/api/v1/admin/users/${env.viewer.id}/roles`, {
      roleIds: [adminRole.id],
    });
    expect(res.statusCode).toBe(403);
    // system roles are immutable
    expect(
      (
        await call('PUT', admin, `/api/v1/admin/roles/${adminRole.id}/permissions`, {
          permissions: [],
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('platform-only endpoints', () => {
  it('are closed to other companies and to non-platform permission holders', async () => {
    expect((await call('GET', other, '/api/v1/admin/models')).statusCode).toBe(403);
    expect((await call('GET', viewer, '/api/v1/admin/sources')).statusCode).toBe(403);
  });

  it('model versions: one production, eval_report required, forward-only', async () => {
    const mk = async (version: string, evalReport?: object) =>
      (
        await call('POST', admin, '/api/v1/admin/models', {
          name: 'invoice-extractor',
          version,
          kind: 'classifier',
          artifactUri: 's3://m/' + version,
          ...(evalReport ? { evalReport } : {}),
        })
      ).json().id as string;
    const a = await mk('1', { f1: 0.9 });
    const b = await mk('2', { f1: 0.95 });
    const c = await mk('3');
    const st = (id: string, status: string) =>
      call('PUT', admin, `/api/v1/admin/models/${id}/status`, { status });
    expect((await st(a, 'production')).statusCode).toBe(409); // candidate → production yasaq
    await st(a, 'canary');
    expect((await st(a, 'production')).json().status).toBe('production');
    await st(b, 'canary');
    await st(b, 'production');
    const list = (await call('GET', admin, '/api/v1/admin/models')).json() as {
      versions: Array<{ id: string; status: string }>;
      serving: { available: boolean };
    };
    expect(list.versions.find((v) => v.id === a)!.status).toBe('retired');
    expect(list.versions.filter((v) => v.status === 'production')).toHaveLength(1);
    expect(list.serving.available).toBe(false);
    await st(c, 'canary');
    expect((await st(c, 'production')).statusCode).toBe(409); // eval_report yoxdur
    expect((await st(a, 'candidate')).statusCode).toBe(409); // retired geri qayıtmır
  });

  it('tax rates: proposal → approval required, never active directly', async () => {
    const res = await call('POST', admin, '/api/v1/admin/tax-rates', {
      taxType: 'VAT',
      code: 'STD-TEST',
      ratePercent: '19',
      validFrom: '2031-01-01',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('proposed');
    const id = res.json().id as string;
    const req = await call('POST', admin, `/api/v1/admin/tax-rates/${id}/request-activation`);
    expect(req.statusCode).toBe(202);
    expect(req.json().status).toBe('approval_required');
    const again = await call('POST', admin, `/api/v1/admin/tax-rates/${id}/request-activation`);
    expect(again.json().approvalId).toBe(req.json().approvalId);
  });
});
