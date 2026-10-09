import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { testConfig, type AppConfig } from '../../src/config.js';
import { PgliteDb, createRepos, migrate, type Db, type Repos } from '../../src/db/index.js';
import { JobWorker, buildHandlers } from '../../src/jobs/index.js';
import { ExtractorRegistry } from '../../src/documents/index.js';
import { NoopScanner, hashPassword, type AntivirusScanner } from '../../src/security/index.js';
import { registerModelExtractors } from '../../src/documents/model-extractors.js';
import type { ModelServing } from '../../src/models/client.js';
import type { LlmClient } from '../../src/llm/client.js';
import type { Embedder, Reranker } from '../../src/rag/clients.js';
import { MemoryStorage } from '../../src/storage/index.js';

export const PASSWORD = 'Str0ng-Passw0rd!';
export const ORIGIN = 'http://localhost:3000';

export interface TestUser {
  id: string;
  email: string;
  companyId: string;
}

export interface TestEnv {
  app: FastifyInstance;
  db: Db;
  repos: Repos;
  config: AppConfig;
  storage: MemoryStorage;
  scanner: { current: AntivirusScanner };
  extractors: ExtractorRegistry;
  worker: JobWorker;
  companyA: string;
  companyB: string;
  admin: TestUser;
  approver: TestUser;
  viewer: TestUser;
  otherCompanyAdmin: TestUser;
  login(
    email: string,
    password?: string,
  ): Promise<{ accessToken: string; csrfToken: string; cookie: string }>;
  bearer(accessToken: string): Record<string, string>;
  close(): Promise<void>;
}

let voenCounter = 1000000000;

async function makeCompany(repos: Repos, name: string): Promise<string> {
  const now = new Date();
  const id = randomUUID();
  await repos.companies.create({
    id,
    name,
    voen: String(voenCounter++),
    baseCurrency: 'AZN',
    isVatPayer: true,
    taxRegime: 'general',
    reportingStandard: 'MMUS',
    chartOfAccountsId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  return id;
}

async function makeUser(
  repos: Repos,
  companyId: string,
  email: string,
  role: string,
  passwordHash: string,
): Promise<TestUser> {
  const now = new Date();
  const user = await repos.users.create({
    id: randomUUID(),
    companyId,
    email,
    passwordHash,
    status: 'active',
    mfaSecret: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  const r = await repos.roles.findRoleByName(role);
  if (!r) throw new Error(`role ${role} missing`);
  await repos.roles.assignRoleToUser(user.id, r.id);
  return { id: user.id, email: user.email, companyId };
}

export async function createTestEnv(
  overrides: Partial<AppConfig> = {},
  opts: {
    scanner?: AntivirusScanner;
    embedder?: Embedder;
    reranker?: Reranker;
    llm?: LlmClient;
    models?: ModelServing;
  } = {},
): Promise<TestEnv> {
  const db = await PgliteDb.create();
  await migrate(db);
  const repos = createRepos(db);
  const config = testConfig(overrides);
  const storage = new MemoryStorage();
  // scanner testdə dəyişdirilə bilsin deyə proxy ilə
  const scanner = { current: opts.scanner ?? new NoopScanner() };
  const extractors = new ExtractorRegistry();
  registerModelExtractors(extractors, opts.models);
  const app = await buildApp({
    config,
    db,
    storage,
    embedder: opts.embedder,
    reranker: opts.reranker,
    llm: opts.llm,
    models: opts.models,
    scanner: { scan: (d) => scanner.current.scan(d), ping: () => scanner.current.ping() },
  });
  const worker = new JobWorker({
    deps: {
      db,
      repos,
      storage,
      extractors,
      embedder: opts.embedder,
      models: opts.models,
      reviewThreshold: config.extractionReviewThreshold,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    },
    handlers: buildHandlers(),
  });
  await app.ready();

  const hash = await hashPassword(PASSWORD);
  const companyA = await makeCompany(repos, 'Alpha MMC');
  const companyB = await makeCompany(repos, 'Beta MMC');
  const admin = await makeUser(repos, companyA, 'admin@alpha.az', 'admin', hash);
  const approver = await makeUser(repos, companyA, 'approver@alpha.az', 'approver', hash);
  const viewer = await makeUser(repos, companyA, 'viewer@alpha.az', 'viewer', hash);
  const otherCompanyAdmin = await makeUser(repos, companyB, 'admin@beta.az', 'admin', hash);

  async function login(email: string, password = PASSWORD) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
      headers: { 'user-agent': 'vitest' },
    });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
    const body = res.json<{ accessToken: string; csrfToken: string }>();
    const cookie = res.cookies.find((c) => c.name === 'refresh_token');
    if (!cookie) throw new Error('no refresh cookie');
    return { accessToken: body.accessToken, csrfToken: body.csrfToken, cookie: cookie.value };
  }

  return {
    app,
    db,
    repos,
    config,
    storage,
    scanner,
    extractors,
    worker,
    companyA,
    companyB,
    admin,
    approver,
    viewer,
    otherCompanyAdmin,
    login,
    bearer: (t) => ({ authorization: `Bearer ${t}` }),
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
