import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

export interface AccessClaims {
  sub: string;
  companyId: string;
  email: string;
  roles: string[];
  permissions: string[];
}

const ALG = 'HS256';
const ISSUER = 'lexaudit-api';
const keyOf = (secret: string) => new TextEncoder().encode(secret);

/** A-07: müddət konfiqdən gəlir (dinamik), sabit deyil. */
export async function createAccessToken(
  claims: AccessClaims,
  ttlMinutes: number,
  secret: string,
): Promise<string> {
  return new SignJWT({
    companyId: claims.companyId,
    email: claims.email,
    roles: claims.roles,
    permissions: claims.permissions,
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ttlMinutes}m`)
    .sign(keyOf(secret));
}

export type VerifyResult =
  { ok: true; claims: AccessClaims } | { ok: false; reason: 'expired' | 'invalid' };

export async function verifyAccessToken(token: string, secret: string): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, keyOf(secret), {
      algorithms: [ALG],
      issuer: ISSUER,
    });
    const { sub, companyId, email, roles, permissions } = payload as Record<string, unknown>;
    if (
      typeof sub !== 'string' ||
      typeof companyId !== 'string' ||
      typeof email !== 'string' ||
      !Array.isArray(roles) ||
      !Array.isArray(permissions)
    ) {
      return { ok: false, reason: 'invalid' };
    }
    return {
      ok: true,
      claims: {
        sub,
        companyId,
        email,
        roles: roles.map(String),
        permissions: permissions.map(String),
      },
    };
  } catch (err) {
    return { ok: false, reason: err instanceof joseErrors.JWTExpired ? 'expired' : 'invalid' };
  }
}

/** 256-bit təsadüfi refresh token (brauzerə cookie ilə gedir, DB-də yalnız hash). */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * CSRF token = HMAC(csrfSecret, refreshToken). Sessiyaya bağlıdır, state saxlamır.
 * Cookie ilə autentifikasiya olunan endpoint-lərdə (refresh/logout) `x-csrf-token` başlığında tələb olunur.
 */
export function createCsrfToken(refreshToken: string, secret: string): string {
  return createHmac('sha256', secret).update(refreshToken).digest('hex');
}

export function verifyCsrfToken(
  token: string | undefined,
  refreshToken: string,
  secret: string,
): boolean {
  if (!token) return false;
  const expected = Buffer.from(createCsrfToken(refreshToken, secret));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
