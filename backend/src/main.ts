import http from 'node:http';
import { buildApp } from './app.js';
import { seedDevAdmin, seedDevTaxRates } from './bootstrap.js';
import { ExtractorRegistry } from './documents/index.js';
import { registerModelExtractors } from './documents/model-extractors.js';
import { createInfra } from './infra.js';
import { SafeFetcher } from './ingestion/fetcher.js';
import { CronScheduler, JobWorker, QUEUES, buildHandlers } from './jobs/index.js';
import { ConfigError, loadConfig, type AppConfig } from './config.js';
import { PgDb, PgliteDb, createRepos, migrate, type Db } from './db/index.js';

let config: AppConfig;
try {
  config = loadConfig();
} catch (err) {
  // §3: eksik/yanlış secret → start olmur
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const stopTelemetry = config.otlpEndpoint
  ? (await import('./telemetry.js')).startTelemetry(config.otlpEndpoint)
  : undefined;

async function openDb(): Promise<Db> {
  if (config.databaseUrl) {
    // Qoşulma alınmırsa SAXTA fallback yoxdur (A-13): proses dayanır.
    const db = PgDb.connect(config.databaseUrl);
    await db.ping();
    return db;
  }
  if (config.appEnv === 'development') {
    console.warn(
      'DATABASE_URL is not set — using an IN-MEMORY dev database (data is lost on exit).',
    );
    return PgliteDb.create();
  }
  throw new Error('DATABASE_URL is required');
}

let db: Db;
try {
  db = await openDb();
  if (config.autoMigrate) {
    const res = await migrate(db);
    if (res.applied.length) console.info(`migrations applied: ${res.applied.join(', ')}`);
  }
  if (config.appEnv === 'development') {
    const { created } = await seedDevTaxRates(db);
    if (created) console.info(`dev sample VAT rates created (NOT real legislation): ${created}`);
  }
  if (config.appEnv === 'development' && config.devSeed) {
    const { created } = await seedDevAdmin(db, config.devSeed);
    if (created) console.info(`dev admin created: ${config.devSeed.email}`);
  }
} catch (err) {
  console.error('Startup failed:', err);
  process.exit(1);
}

let infra: Awaited<ReturnType<typeof createInfra>>;
try {
  infra = await createInfra(config);
} catch (err) {
  console.error('Startup failed (object storage):', err);
  process.exit(1);
}
for (const w of infra.warnings) console.warn(w);

const app = await buildApp({
  config,
  db,
  storage: infra.storage,
  scanner: infra.scanner,
  embedder: infra.embedder,
  reranker: infra.reranker,
});

// Fon işləri (Postgres SKIP LOCKED növbəsi). Ayrıca prosesdə işlətmək üçün JOBS_ENABLED=false.
const extractors = new ExtractorRegistry();
registerModelExtractors(extractors, infra.models);
const worker = config.jobs.enabled
  ? new JobWorker({
      deps: {
        db,
        repos: createRepos(db),
        storage: infra.storage,
        extractors,
        embedder: infra.embedder,
        models: infra.models,
        reviewThreshold: config.extractionReviewThreshold,
        fetcher: new SafeFetcher({
          userAgent: 'LexAuditBot/1.0 (+contact: admin; respects robots.txt)',
        }),
        log: app.log,
      },
      handlers: buildHandlers(),
      pollIntervalMs: config.jobs.pollIntervalMs,
    })
  : undefined;

// Prometheus metrikləri ayrı (daxili) portda — ictimai API-də açıq deyil
let metricsServer: http.Server | undefined;
if (config.prometheusListenAddr) {
  const m = /^(.*):(\d+)$/.exec(config.prometheusListenAddr);
  if (!m) {
    console.error(`PROMETHEUS_LISTEN_ADDR must be host:port (got ${config.prometheusListenAddr})`);
    process.exit(1);
  }
  metricsServer = http.createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    app.metrics.registry.metrics().then(
      (body) => res.writeHead(200, { 'content-type': app.metrics.registry.contentType }).end(body),
      () => res.writeHead(500).end(),
    );
  });
  metricsServer.listen(Number(m[2]), m[1]);
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    scheduler?.stop();
    await worker?.stop();
    metricsServer?.close();
    await db.close();
    await stopTelemetry?.();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
worker?.start();
const scheduler = config.jobs.enabled
  ? new CronScheduler(createRepos(db).jobs, app.log)
  : undefined;
if (scheduler) {
  scheduler.add({ name: 'sources-tick', pattern: '* * * * *', queue: QUEUES.SOURCES_TICK });
  scheduler.add({ name: 'embeddings-tick', pattern: '*/5 * * * *', queue: QUEUES.EMBEDDINGS_RUN });
  scheduler.add({ name: 'sources-health', pattern: '7 * * * *', queue: QUEUES.SOURCES_HEALTH });
  scheduler.start();
}
app.log.info(`Health:  http://${config.host}:${config.port}/admin/health`);
if (config.appEnv !== 'production') {
  app.log.info(`OpenAPI: http://${config.host}:${config.port}/api/v1/openapi.json`);
}
