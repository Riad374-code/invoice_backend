import { randomUUID } from 'node:crypto';

export interface AuditEvent {
  id: string;
  companyId: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  before: unknown;
  after: unknown;
  requestId: string;
  createdAt: Date;
}

export function newAuditEvent(
  input: Omit<AuditEvent, 'id' | 'createdAt'> & { now?: Date },
): AuditEvent {
  const { now, ...rest } = input;
  return { ...rest, id: randomUUID(), createdAt: now ?? new Date() };
}
