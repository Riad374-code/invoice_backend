import { newAuditEvent, type AuditEvent } from '../domain/index.js';
import type { Db } from '../db/index.js';
import { AuditRepository } from '../db/repos/audit.js';
import { maskJsonValue } from './pii.js';

export interface AuditInput {
  companyId: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  before?: unknown;
  after?: unknown;
  requestId: string;
}

/**
 * Dəyişməz audit jurnalı yazıcısı (yalnız INSERT). PII yazılmadan əvvəl maskalanır.
 * A-13: DB xətası udulmur — çağıran tərəfə atılır (saxta uğur yoxdur).
 * Mutasiya ilə eyni transaksiyada yazmaq üçün `db` verin.
 */
export class AuditLogger {
  constructor(private readonly db: Db) {}

  async log(input: AuditInput, db: Db = this.db): Promise<AuditEvent> {
    const event = newAuditEvent({
      companyId: input.companyId,
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      before: input.before === undefined ? null : maskJsonValue(input.before),
      after: input.after === undefined ? null : maskJsonValue(input.after),
      requestId: input.requestId,
    });
    await new AuditRepository(db).insert(event);
    return event;
  }

  list(companyId: string, limit: number): Promise<AuditEvent[]> {
    return new AuditRepository(this.db).listByCompany(companyId, limit);
  }
}
