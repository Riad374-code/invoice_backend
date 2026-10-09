import { describe, expect, it } from 'vitest';
import {
  createAccessToken,
  createCsrfToken,
  generateRefreshToken,
  hashPassword,
  hashRefreshToken,
  totpAt,
  verifyAccessToken,
  verifyCsrfToken,
  verifyPassword,
  verifyTotp,
} from './index.js';

const SECRET = 'very-secure-jwt-secret-with-minimum-32-bytes';

describe('password (Argon2id)', () => {
  it('hashes and verifies', async () => {
    const hash = await hashPassword('SecretPass123!@#');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword('SecretPass123!@#', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
  it('returns false for a malformed hash instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});

describe('access token', () => {
  const claims = {
    sub: '3f4a6a0e-0000-4000-8000-000000000001',
    companyId: '3f4a6a0e-0000-4000-8000-000000000002',
    email: 'a@b.az',
    roles: ['admin'],
    permissions: ['invoices:read'],
  };

  it('round-trips claims', async () => {
    const token = await createAccessToken(claims, 15, SECRET);
    const res = await verifyAccessToken(token, SECRET);
    expect(res).toEqual({ ok: true, claims });
  });
  it('rejects a wrong secret and garbage', async () => {
    const token = await createAccessToken(claims, 15, SECRET);
    expect(await verifyAccessToken(token, SECRET + 'x')).toEqual({ ok: false, reason: 'invalid' });
    expect(await verifyAccessToken('garbage', SECRET)).toEqual({ ok: false, reason: 'invalid' });
  });
  it('reports expiry distinctly', async () => {
    const token = await createAccessToken(claims, -1, SECRET);
    expect(await verifyAccessToken(token, SECRET)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('refresh + csrf tokens', () => {
  it('refresh tokens are random, hashed deterministically and never equal their hash', () => {
    const a = generateRefreshToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateRefreshToken()).not.toBe(a);
    expect(hashRefreshToken(a)).toBe(hashRefreshToken(a));
    expect(hashRefreshToken(a)).not.toBe(a);
  });
  it('csrf token is bound to the refresh token and secret', () => {
    const refresh = generateRefreshToken();
    const csrf = createCsrfToken(refresh, 'csrf-secret-csrf-secret-csrf-secret');
    expect(verifyCsrfToken(csrf, refresh, 'csrf-secret-csrf-secret-csrf-secret')).toBe(true);
    expect(
      verifyCsrfToken(csrf, generateRefreshToken(), 'csrf-secret-csrf-secret-csrf-secret'),
    ).toBe(false);
    expect(verifyCsrfToken(csrf, refresh, 'another-secret-another-secret-123')).toBe(false);
    expect(verifyCsrfToken(undefined, refresh, 'csrf-secret-csrf-secret-csrf-secret')).toBe(false);
    expect(verifyCsrfToken('short', refresh, 'csrf-secret-csrf-secret-csrf-secret')).toBe(false);
  });
});

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 Appendix B, SHA-1, secret "12345678901234567890" → base32 below
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  it('matches the RFC test vectors (6-digit truncation)', () => {
    expect(totpAt(secret, 59_000)).toBe('287082');
    expect(totpAt(secret, 1_111_111_109_000)).toBe('081804');
    expect(totpAt(secret, 1_234_567_890_000)).toBe('005924');
  });
  it('accepts ±1 step drift only', () => {
    const now = 1_111_111_109_000;
    expect(verifyTotp(secret, '081804', now)).toBe(true);
    expect(verifyTotp(secret, '081804', now + 30_000)).toBe(true);
    expect(verifyTotp(secret, '081804', now + 120_000)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', now)).toBe(false);
  });
});
