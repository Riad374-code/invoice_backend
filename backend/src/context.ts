import type { AppConfig } from './config.js';
import type { AuditLogger } from './audit/index.js';
import type { Db, Repos } from './db/index.js';
import type { PermissionCode } from './domain/index.js';
import type { FixedWindowRateLimiter } from './plugins/rate-limit.js';
import type { AntivirusScanner } from './security/antivirus.js';
import type { ToolGateway } from './agent/gateway.js';
import type { ToolRegistry } from './agent/tools.js';
import type { RagOcrClient } from './ragocr/client.js';
import type { ModelServing } from './models/client.js';
import type { LlmClient } from './llm/client.js';
import type { Embedder, Reranker } from './rag/clients.js';
import type { ObjectStorage } from './storage/index.js';

export interface AuthUser {
  userId: string;
  companyId: string;
  email: string;
  roles: string[];
  permissions: string[];
}

/** Handler-lərin ehtiyacı olan bütün asılılıqlar (DI). */
export interface AppContext {
  config: AppConfig;
  db: Db;
  repos: Repos;
  audit: AuditLogger;
  rateLimiter: FixedWindowRateLimiter;
  storage: ObjectStorage;
  scanner: AntivirusScanner;
  embedder?: Embedder | undefined;
  llm?: LlmClient | undefined;
  models?: ModelServing | undefined;
  ragOcr?: RagOcrClient | undefined;
  tools: ToolRegistry;
  gateway: ToolGateway;
  reranker?: Reranker | undefined;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    auth: AuthUser | null;
    /** Handler audit_events-ə yazıbsa true (bax: plugins/audit-guard.ts). */
    auditRecorded: boolean;
  }
  interface FastifyContextConfig {
    /** Autentifikasiyasız açıq endpoint (açıq-açıq elan olunmalıdır). */
    public?: boolean;
    /** Yalnız giriş tələb olunur (xüsusi icazə yox) — məs. GET /me. */
    authOnly?: boolean;
    /** A-02: tələb olunan icazə kodu. */
    permission?: PermissionCode;
    /** Audit safety-net-dən çıxarılır (məs. auth axınları özü yazır). */
    skipAudit?: boolean;
  }
}
