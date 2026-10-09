import { z } from 'zod';

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration — server refusing to start:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export interface AppConfig {
  appEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  publicBaseUrl: string;
  corsAllowedOrigins: string[];
  trustProxy: boolean;
  autoMigrate: boolean;
  databaseUrl: string | undefined;
  jwtSecret: string;
  csrfSecret: string;
  accessTokenTtlMinutes: number;
  refreshTokenTtlDays: number;
  loginRateLimitPerMinute: number;
  globalRateLimitPerMinute: number;
  logLevel: string;
  s3: {
    endpoint: string | undefined;
    region: string | undefined;
    bucket: string | undefined;
    accessKey: string | undefined;
    secretKey: string | undefined;
  };
  modelServingBaseUrl: string | undefined;
  /** Vektor nəticələri üçün minimum cosine oxşarlığı; embedding modelinə görə kalibrləməlidir. */
  ragMinSimilarity: number;
  /** Hər istifadəçi üçün dəqiqədə maksimum assistent mesajı. */
  chatRateLimitPerMinute: number;
  /** Təsir analizi: fayl parçası ilə minimum cosine oxşarlığı (embedding modelinə görə kalibrləməlidir). */
  impactMinSimilarity: number;
  /** AI çıxarışında bu etibarlılıqdan aşağı sahələr insan yoxlaması tələb edir (BACKEND.md §7). */
  extractionReviewThreshold: number;
  ragOcr: { baseUrl: string; token: string } | undefined;
  models: { apiKey: string | undefined; embedding: string; rerank: string; chat: string };
  /** §11: fayl yükləmə ölçü limiti (bayt). */
  maxUploadBytes: number;
  /** §11: antivirus. `clamav` = clamd INSTREAM; `disabled` yalnız dev/test və ya açıq CLAMAV_DISABLED=true. */
  antivirus: { mode: 'clamav'; host: string; port: number } | { mode: 'disabled' };
  jobs: { enabled: boolean; pollIntervalMs: number };
  otlpEndpoint: string | undefined;
  prometheusListenAddr: string | undefined;
  /** SEED_DEMO_DATA=true (+ DEMO_PASSWORD ≥12 simvol): ayrı DEMO şirkəti və nümunə məlumat; istənilən mühitdə. */
  demoSeed: { password: string } | undefined;
  /** Yalnız development: ilk admin istifadəçi/şirkət (DEV_ADMIN_EMAIL + DEV_ADMIN_PASSWORD verilərsə). */
  devSeed: { email: string; password: string; companyName: string; voen: string } | undefined;
}

const MIN_SECRET_LENGTH = 32;
const PLACEHOLDER = /^change-?me/i;

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const intFromEnv = (def: number, min = 1) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : Number(v)))
    .pipe(z.number().int().min(min));

const boolFromEnv = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === '' ? def : ['1', 'true', 'yes'].includes(v.toLowerCase()),
    );

const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BIND_ADDR: z.string().default('0.0.0.0:8080'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:8080'),
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  TRUST_PROXY: boolFromEnv(false),
  AUTO_MIGRATE: z.string().optional(),
  DATABASE_URL: optionalString,
  JWT_SECRET: z.string({ error: 'JWT_SECRET is required' }),
  CSRF_SECRET: z.string({ error: 'CSRF_SECRET is required' }),
  ACCESS_TOKEN_TTL_MINUTES: intFromEnv(15),
  REFRESH_TOKEN_TTL_DAYS: intFromEnv(30),
  LOGIN_RATE_LIMIT_PER_MINUTE: intFromEnv(10),
  GLOBAL_RATE_LIMIT_PER_MINUTE: intFromEnv(600),
  LOG_LEVEL: z.string().default('info'),
  S3_ENDPOINT: optionalString,
  S3_REGION: optionalString,
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY: optionalString,
  S3_SECRET_KEY: optionalString,
  MODEL_SERVING_BASE_URL: optionalString,
  MODEL_SERVING_API_KEY: optionalString,
  RAG_OCR_BASE_URL: optionalString,
  RAG_OCR_TOKEN: optionalString,
  EMBEDDING_MODEL: z.string().default('bge-m3'),
  RERANK_MODEL: z.string().default('bge-reranker-v2-m3'),
  CHAT_MODEL: z.string().default('lexaudit-chat'),
  CHAT_RATE_LIMIT_PER_MINUTE: intFromEnv(20),
  IMPACT_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.6),
  EXTRACTION_REVIEW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  RAG_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.35),
  MAX_UPLOAD_BYTES: intFromEnv(20 * 1024 * 1024),
  CLAMAV_HOST: optionalString,
  CLAMAV_PORT: intFromEnv(3310),
  CLAMAV_DISABLED: boolFromEnv(false),
  JOBS_ENABLED: boolFromEnv(true),
  JOBS_POLL_INTERVAL_MS: intFromEnv(1000, 50),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalString,
  PROMETHEUS_LISTEN_ADDR: optionalString,
  SEED_DEMO_DATA: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DEMO_PASSWORD: optionalString,
  DEV_ADMIN_EMAIL: optionalString,
  DEV_ADMIN_PASSWORD: optionalString,
});

/**
 * §3: "typed config, eksik secret → start olmur". Yalnız env-dən oxuyur;
 * bütün problemləri bir dəfəyə toplayıb ConfigError atır.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  const issues: string[] = [];
  const isProd = e.APP_ENV === 'production';

  for (const [name, value] of [
    ['JWT_SECRET', e.JWT_SECRET],
    ['CSRF_SECRET', e.CSRF_SECRET],
  ] as const) {
    if (value.trim().length < MIN_SECRET_LENGTH) {
      issues.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
    } else if (isProd && PLACEHOLDER.test(value.trim())) {
      issues.push(`${name} still has the placeholder value — set a real random secret`);
    }
  }
  if (e.JWT_SECRET === e.CSRF_SECRET) issues.push('JWT_SECRET and CSRF_SECRET must differ');

  const bind = /^(.*):(\d{1,5})$/.exec(e.BIND_ADDR);
  const port = bind ? Number(bind[2]) : NaN;
  if (!bind || port < 0 || port > 65535) {
    issues.push(`BIND_ADDR must look like host:port (got "${e.BIND_ADDR}")`);
  }

  const cors = e.CORS_ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (cors.length === 0) issues.push('CORS_ALLOWED_ORIGINS needs at least one origin');
  for (const origin of cors) {
    if (origin === '*') issues.push('CORS_ALLOWED_ORIGINS must list concrete origins, not "*"');
    else {
      try {
        const u = new URL(origin);
        if (u.origin !== origin)
          issues.push(`CORS origin "${origin}" must have no path or trailing slash`);
      } catch {
        issues.push(`CORS origin "${origin}" is not a valid URL`);
      }
    }
  }

  if (e.SEED_DEMO_DATA && (e.DEMO_PASSWORD?.length ?? 0) < 12)
    issues.push(
      'SEED_DEMO_DATA=true requires DEMO_PASSWORD of at least 12 characters (no default password)',
    );
  if (isProd && !e.DATABASE_URL) issues.push('DATABASE_URL is required in production');

  if (isProd) {
    for (const [name, value] of [
      ['S3_BUCKET', e.S3_BUCKET],
      ['S3_REGION', e.S3_REGION],
      ['S3_ACCESS_KEY', e.S3_ACCESS_KEY],
      ['S3_SECRET_KEY', e.S3_SECRET_KEY],
    ] as const) {
      if (!value) issues.push(`${name} is required in production (object storage)`);
    }
    if (!e.CLAMAV_HOST && !e.CLAMAV_DISABLED) {
      issues.push('CLAMAV_HOST is required in production (or set CLAMAV_DISABLED=true explicitly)');
    }
  }
  if (e.MAX_UPLOAD_BYTES > 25 * 1024 * 1024) {
    issues.push('MAX_UPLOAD_BYTES must be <= 26214400 (clamd StreamMaxLength default is 25 MiB)');
  }

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    appEnv: e.APP_ENV,
    host: bind?.[1] ?? '0.0.0.0',
    port,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    corsAllowedOrigins: cors,
    trustProxy: e.TRUST_PROXY,
    // dev/test-də avtomatik; production-da migrasiya ayrıca addım kimi (`npm run migrate`) işləyir
    autoMigrate:
      e.AUTO_MIGRATE === undefined || e.AUTO_MIGRATE === ''
        ? e.APP_ENV !== 'production'
        : ['1', 'true', 'yes'].includes(e.AUTO_MIGRATE.toLowerCase()),
    databaseUrl: e.DATABASE_URL,
    jwtSecret: e.JWT_SECRET,
    csrfSecret: e.CSRF_SECRET,
    accessTokenTtlMinutes: e.ACCESS_TOKEN_TTL_MINUTES,
    refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    loginRateLimitPerMinute: e.LOGIN_RATE_LIMIT_PER_MINUTE,
    globalRateLimitPerMinute: e.GLOBAL_RATE_LIMIT_PER_MINUTE,
    logLevel: e.LOG_LEVEL,
    s3: {
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKey: e.S3_ACCESS_KEY,
      secretKey: e.S3_SECRET_KEY,
    },
    modelServingBaseUrl: e.MODEL_SERVING_BASE_URL,
    ragOcr:
      e.RAG_OCR_BASE_URL && e.RAG_OCR_TOKEN
        ? { baseUrl: e.RAG_OCR_BASE_URL, token: e.RAG_OCR_TOKEN }
        : undefined,
    ragMinSimilarity: e.RAG_MIN_SIMILARITY,
    chatRateLimitPerMinute: e.CHAT_RATE_LIMIT_PER_MINUTE,
    impactMinSimilarity: e.IMPACT_MIN_SIMILARITY,
    extractionReviewThreshold: e.EXTRACTION_REVIEW_THRESHOLD,
    models: {
      apiKey: e.MODEL_SERVING_API_KEY,
      embedding: e.EMBEDDING_MODEL,
      rerank: e.RERANK_MODEL,
      chat: e.CHAT_MODEL,
    },
    maxUploadBytes: e.MAX_UPLOAD_BYTES,
    antivirus:
      e.CLAMAV_HOST && !e.CLAMAV_DISABLED
        ? { mode: 'clamav', host: e.CLAMAV_HOST, port: e.CLAMAV_PORT }
        : { mode: 'disabled' },
    jobs: { enabled: e.JOBS_ENABLED, pollIntervalMs: e.JOBS_POLL_INTERVAL_MS },
    otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
    prometheusListenAddr: e.PROMETHEUS_LISTEN_ADDR,
    demoSeed: e.SEED_DEMO_DATA && e.DEMO_PASSWORD ? { password: e.DEMO_PASSWORD } : undefined,
    devSeed:
      e.DEV_ADMIN_EMAIL && e.DEV_ADMIN_PASSWORD
        ? {
            email: e.DEV_ADMIN_EMAIL,
            password: e.DEV_ADMIN_PASSWORD,
            companyName: 'Dev Company MMC',
            voen: '1234567890',
          }
        : undefined,
  };
}

/** Testlər üçün: etibarlı konfiq + override. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({
      APP_ENV: 'test',
      JWT_SECRET: 'test-jwt-secret-at-least-32-bytes-long!!',
      CSRF_SECRET: 'test-csrf-secret-at-least-32-bytes-long!',
      CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
      LOG_LEVEL: 'silent',
    }),
    ...overrides,
  };
}
