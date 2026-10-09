import { randomUUID } from 'node:crypto';
import { DomainError } from './errors.js';

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface Approval {
  id: string;
  companyId: string;
  kind: string;
  resourceRef: string;
  payload: unknown;
  requesterId: string;
  approverId: string | null;
  status: ApprovalStatus;
  expiresAt: Date;
  decidedAt: Date | null;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function newApproval(input: {
  companyId: string;
  kind: string;
  resourceRef: string;
  payload: unknown;
  requesterId: string;
  expiresAt: Date;
  now?: Date;
}): Approval {
  const now = input.now ?? new Date();
  return {
    id: randomUUID(),
    companyId: input.companyId,
    kind: input.kind,
    resourceRef: input.resourceRef,
    payload: input.payload,
    requesterId: input.requesterId,
    approverId: null,
    status: 'pending',
    expiresAt: input.expiresAt,
    decidedAt: null,
    comment: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Müddəti bitmiş pending sorğunu `expired` edir (dəyişdirilmiş surəti qaytarır). */
export function expireIfDue(approval: Approval, now: Date): Approval {
  if (approval.status === 'pending' && now.getTime() > approval.expiresAt.getTime()) {
    return { ...approval, status: 'expired', updatedAt: now };
  }
  return approval;
}

function assertDecidable(approval: Approval, approverId: string, target: ApprovalStatus): void {
  // A-03: təsdiqləyən sorğu sahibi ola bilməz
  if (approverId === approval.requesterId) {
    throw new DomainError(
      'SELF_APPROVAL_FORBIDDEN',
      'Requester cannot decide on their own approval request (A-03)',
    );
  }
  // A-04: yalnız pending → approved/rejected
  if (approval.status !== 'pending') {
    throw new DomainError(
      'INVALID_STATE_TRANSITION',
      `Cannot move approval from ${approval.status} to ${target}: only pending approvals can be decided (A-04)`,
    );
  }
}

function decide(
  approval: Approval,
  status: 'approved' | 'rejected',
  approverId: string,
  comment: string | null,
  now: Date,
): Approval {
  assertDecidable(approval, approverId, status);
  if (now.getTime() > approval.expiresAt.getTime()) {
    throw new DomainError('INVALID_STATE_TRANSITION', 'Approval has already expired');
  }
  return { ...approval, status, approverId, decidedAt: now, comment, updatedAt: now };
}

export function approve(
  approval: Approval,
  approverId: string,
  comment: string | null,
  now: Date,
): Approval {
  return decide(approval, 'approved', approverId, comment, now);
}

export function reject(
  approval: Approval,
  approverId: string,
  comment: string | null,
  now: Date,
): Approval {
  return decide(approval, 'rejected', approverId, comment, now);
}
