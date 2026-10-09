import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maskJsonValue } from '../../src/audit/pii.js';
import { createTestEnv, PASSWORD, type TestEnv } from '../helpers/app.js';

let env: TestEnv;
let base: string;
beforeAll(async () => {
  env = await createTestEnv({ loginRateLimitPerMinute: 1000, logLevel: 'info' });
  base = await env.app.listen({ port: 0, host: '127.0.0.1' }); // real socket, not inject()
});
afterAll(() => env.close());

describe('real HTTP (regression: log masking recursed through req.raw.socket and crashed the process)', () => {
  it('serves a login over a real socket with request logging on', async () => {
    const res = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ email: env.admin.email, password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { accessToken?: string }).accessToken).toBeTruthy();
    expect((await fetch(`${base}/api/v1/admin/health`)).status).toBe(200);
  });
  it('masks safely on cyclic and deep structures', () => {
    const a: Record<string, unknown> = { password: 'x', voen: '1234567890' };
    a['self'] = a;
    const out = maskJsonValue(a) as Record<string, unknown>;
    expect(out['password']).toBe('[REDACTED]');
    expect(out['self']).toBe('[Circular]');
    expect(out['voen']).toBe('1234****90');
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) deep = { n: deep };
    expect(() => maskJsonValue(deep)).not.toThrow();
  });
});
