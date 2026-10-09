import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const GOOD = {
  JWT_SECRET: 'a'.repeat(40),
  CSRF_SECRET: 'b'.repeat(40),
};

const PROD = {
  ...GOOD,
  APP_ENV: 'production',
  DATABASE_URL: 'postgres://x',
  S3_BUCKET: 'b',
  S3_REGION: 'r',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
  CLAMAV_HOST: 'clamav',
};

describe('loadConfig (§3: eksik secret → start olmur)', () => {
  it('loads a valid environment with defaults', () => {
    const c = loadConfig(GOOD);
    expect(c).toMatchObject({
      appEnv: 'development',
      host: '0.0.0.0',
      port: 8080,
      accessTokenTtlMinutes: 15,
      refreshTokenTtlDays: 30,
      corsAllowedOrigins: ['http://localhost:3000'],
      autoMigrate: true,
    });
  });
  it('refuses to start without JWT_SECRET or CSRF_SECRET', () => {
    expect(() => loadConfig({ CSRF_SECRET: GOOD.CSRF_SECRET })).toThrow(ConfigError);
    expect(() => loadConfig({ JWT_SECRET: GOOD.JWT_SECRET })).toThrow(/CSRF_SECRET/);
    expect(() => loadConfig({})).toThrow(/JWT_SECRET/);
  });
  it('rejects short, identical or placeholder secrets', () => {
    expect(() => loadConfig({ ...GOOD, JWT_SECRET: 'short' })).toThrow(/at least 32/);
    expect(() => loadConfig({ ...GOOD, CSRF_SECRET: GOOD.JWT_SECRET })).toThrow(/must differ/);
    expect(() =>
      loadConfig({
        ...GOOD,
        ...PROD,
        JWT_SECRET: 'change-me-to-32-bytes-minimum-dev-only',
      }),
    ).toThrow(/placeholder/);
  });
  it('requires DATABASE_URL in production and disables auto-migrate there', () => {
    expect(() => loadConfig({ ...GOOD, APP_ENV: 'production' })).toThrow(/DATABASE_URL/);
    const c = loadConfig(PROD);
    expect(c.autoMigrate).toBe(false);
  });
  it('requires object storage and antivirus in production (§11)', () => {
    expect(() => loadConfig({ ...PROD, S3_BUCKET: '' })).toThrow(/S3_BUCKET/);
    expect(() => loadConfig({ ...PROD, S3_SECRET_KEY: '' })).toThrow(/S3_SECRET_KEY/);
    expect(() => loadConfig({ ...PROD, CLAMAV_HOST: '' })).toThrow(/CLAMAV_HOST/);
    // söndürmək yalnız açıq-aşkar qərarla mümkündür
    const c = loadConfig({ ...PROD, CLAMAV_HOST: '', CLAMAV_DISABLED: 'true' });
    expect(c.antivirus).toEqual({ mode: 'disabled' });
    expect(loadConfig(PROD).antivirus).toEqual({ mode: 'clamav', host: 'clamav', port: 3310 });
  });
  it('caps the upload limit at the clamd stream limit', () => {
    expect(() => loadConfig({ ...GOOD, MAX_UPLOAD_BYTES: String(30 * 1024 * 1024) })).toThrow(
      /MAX_UPLOAD_BYTES/,
    );
    expect(loadConfig(GOOD).maxUploadBytes).toBe(20 * 1024 * 1024);
  });
  it('accepts only concrete CORS origins', () => {
    expect(() => loadConfig({ ...GOOD, CORS_ALLOWED_ORIGINS: '*' })).toThrow(/concrete origins/);
    expect(() => loadConfig({ ...GOOD, CORS_ALLOWED_ORIGINS: 'http://a.az/' })).toThrow(
      /trailing slash/,
    );
    expect(
      loadConfig({ ...GOOD, CORS_ALLOWED_ORIGINS: 'https://a.az, https://b.az' })
        .corsAllowedOrigins,
    ).toEqual(['https://a.az', 'https://b.az']);
  });
  it('reports every problem at once', () => {
    try {
      loadConfig({ JWT_SECRET: 'x', CSRF_SECRET: 'x', BIND_ADDR: 'nonsense' });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).issues.length).toBeGreaterThanOrEqual(3);
    }
  });
  it('requires the sidecar URL and token together instead of silently disabling it', () => {
    expect(() => loadConfig({ ...GOOD, RAG_OCR_BASE_URL: 'http://127.0.0.1:8002' })).toThrow(
      /RAG_OCR_BASE_URL and RAG_OCR_TOKEN must be set together/,
    );
    expect(() =>
      loadConfig({ ...GOOD, RAG_OCR_TOKEN: 'test-token', RAG_OCR_BASE_URL: ' ' }),
    ).toThrow(/must be set together/);
    expect(loadConfig({ ...GOOD, RAG_OCR_BASE_URL: '', RAG_OCR_TOKEN: '' }).ragOcr).toBeUndefined();
    expect(
      loadConfig({
        ...GOOD,
        RAG_OCR_BASE_URL: ' http://127.0.0.1:8002/ ',
        RAG_OCR_TOKEN: 'test-token',
      }).ragOcr,
    ).toEqual({ baseUrl: 'http://127.0.0.1:8002/', token: 'test-token' });
  });
  it.each(['MODEL_SERVING_BASE_URL', 'RAG_OCR_BASE_URL'])(
    'validates the %s service origin',
    (name) => {
      const env = name === 'RAG_OCR_BASE_URL' ? { ...GOOD, RAG_OCR_TOKEN: 'test-token' } : GOOD;
      for (const value of [
        'localhost:8002',
        'ftp://host',
        'http://user:secret@host',
        'http://host/api/chat',
        'http://host?key=secret',
        'http://host/#fragment',
      ]) {
        expect(() => loadConfig({ ...env, [name]: value })).toThrow(
          new RegExp(`${name} must be an HTTP`),
        );
      }
      expect(() => loadConfig({ ...env, [name]: 'https://service.internal:8002' })).not.toThrow();
    },
  );
});
