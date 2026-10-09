import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { AuditLogger } from './audit/index.js';
import { maskJsonValue, maskText } from './audit/pii.js';
import type { AppConfig } from './config.js';
import type { AppContext } from './context.js';
import { createRepos, type Db } from './db/index.js';
import { registerOpenApi } from './openapi.js';
import auditGuard from './plugins/audit-guard.js';
import authPlugin from './plugins/auth.js';
import errorHandler from './plugins/error-handler.js';
import idempotency from './plugins/idempotency.js';
import metrics from './plugins/metrics.js';
import rateLimit, { FixedWindowRateLimiter } from './plugins/rate-limit.js';
import requestId, { generateRequestId } from './plugins/request-id.js';
import adminRoutes from './routes/admin.js';
import approvalRoutes from './routes/approvals.js';
import auditRoutes from './routes/audit.js';
import authRoutes from './routes/auth.js';
import fileRoutes from './routes/files.js';
import invoiceRoutes from './routes/invoices.js';
import knowledgeRoutes from './routes/knowledge.js';
import searchRoutes from './routes/search.js';
import adminConsoleRoutes from './routes/admin-console.js';
import excelRoutes from './routes/excel.js';
import impactRoutes from './routes/impact.js';
import ledgerRoutes from './routes/ledger.js';
import vatRoutes from './routes/vat.js';
import taxRateRoutes from './routes/tax-rates.js';
import type { AntivirusScanner } from './security/antivirus.js';
import { registerBuiltinTools } from './agent/builtin-tools.js';
import { ToolGateway } from './agent/gateway.js';
import { ToolRegistry } from './agent/tools.js';
import assistantRoutes from './routes/assistant.js';
import type { RagOcrClient } from './ragocr/client.js';
import type { ModelServing } from './models/client.js';
import type { LlmClient } from './llm/client.js';
import type { Embedder, Reranker } from './rag/clients.js';
import type { ObjectStorage } from './storage/index.js';

/** Log arqumentlərində PII maskalanır; Error obyektləri (stack trace) toxunulmaz qalır. */
// Fastify-ın `req`/`res`/`err` obyektləri canlı sokets/parser qrafıdır: onları pino serializer-ləri sadələşdirir.
const RAW_LOG_KEYS = new Set(['req', 'res', 'request', 'reply', 'err', 'error']);
function maskLogArg(arg: unknown): unknown {
  if (typeof arg === 'string') return maskText(arg);
  if (arg === null || typeof arg !== 'object' || arg instanceof Error) return arg;
  return Object.fromEntries(
    Object.entries(arg).map(([k, v]) => [
      k,
      RAW_LOG_KEYS.has(k) || v instanceof Error
        ? v
        : (maskJsonValue({ [k]: v }) as Record<string, unknown>)[k],
    ]),
  );
}

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  storage: ObjectStorage;
  scanner: AntivirusScanner;
  embedder?: Embedder | undefined;
  reranker?: Reranker | undefined;
  llm?: LlmClient | undefined;
  models?: ModelServing | undefined;
  ragOcr?: RagOcrClient | undefined;
  /** Test üçün: sabit saatlı limiter vermək olar. */
  rateLimiter?: FixedWindowRateLimiter;
}

export async function buildApp({
  config,
  db,
  storage,
  scanner,
  embedder,
  reranker,
  llm,
  models,
  ragOcr,
  rateLimiter,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[REDACTED]',
      },
      // §11: PII maskalama log-larda (VÖEN, FİN, IBAN, telefon)
      hooks: {
        logMethod(args, method) {
          const masked = args.map(maskLogArg);
          return method.apply(this, masked as unknown as Parameters<typeof method>);
        },
      },
    },
    genReqId: generateRequestId,
    logController: new LogController({
      requestIdLogLabel: 'requestId',
      // sağlamlıq yoxlamaları loqu doldurmasın
      disableRequestLogging: (request) =>
        request.url.split('?')[0]?.endsWith('/admin/health') ?? false,
    }),
    // Yalnız etibarlı reverse proxy arxasında X-Forwarded-For-a etibar et (spoof olunmasın)
    trustProxy: config.trustProxy,
    bodyLimit: 1_048_576,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const limiter = rateLimiter ?? new FixedWindowRateLimiter();
  const tools = new ToolRegistry();
  registerBuiltinTools(tools);
  const ctx: AppContext = {
    config,
    db,
    repos: createRepos(db),
    audit: new AuditLogger(db),
    rateLimiter: limiter,
    storage,
    scanner,
    embedder,
    reranker,
    llm,
    models,
    ragOcr,
    tools,
    gateway: new ToolGateway(tools),
  };
  app.decorate('ctx', ctx);
  app.addHook('onClose', async () => limiter.close());

  await registerOpenApi(app);

  await app.register(requestId);
  await app.register(errorHandler);
  await app.register(metrics);

  // CORS: yalnız konkret origin-lər (auth-dan əvvəl — preflight cavablanmalıdır)
  await app.register(cors, {
    origin: config.corsAllowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'accept',
      'x-request-id',
      'x-csrf-token',
      'idempotency-key',
    ],
    exposedHeaders: ['x-request-id', 'retry-after', 'idempotent-replayed'],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10, fieldSize: 10_000, parts: 12 },
  });
  await app.register(rateLimit);
  await app.register(authPlugin);
  await app.register(idempotency);
  await app.register(auditGuard);

  await app.register(adminRoutes);
  await app.register(authRoutes);
  await app.register(approvalRoutes);
  await app.register(auditRoutes);
  await app.register(fileRoutes);
  await app.register(taxRateRoutes);
  await app.register(invoiceRoutes);
  await app.register(knowledgeRoutes);
  await app.register(searchRoutes);
  await app.register(assistantRoutes);
  await app.register(vatRoutes);
  await app.register(ledgerRoutes);
  await app.register(excelRoutes);
  await app.register(impactRoutes);
  await app.register(adminConsoleRoutes);

  // Sxem yalnız istehsaldan kənarda HTTP ilə verilir; CLI (`npm run openapi`) həmişə işləyir.
  if (config.appEnv !== 'production') {
    app.get(
      '/api/v1/openapi.json',
      { config: { public: true, skipAudit: true }, schema: { hide: true } },
      async () => app.swagger(),
    );
  }

  return app;
}
