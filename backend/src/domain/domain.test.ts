import { describe, expect, it } from 'vitest';
import {
  approve,
  expireIfDue,
  newApproval,
  reject,
  transitionUserStatus,
  DomainError,
} from './index.js';

const company = '00000000-0000-4000-8000-000000000001';
const requester = '00000000-0000-4000-8000-0000000000a1';
const approver = '00000000-0000-4000-8000-0000000000a2';
const T0 = new Date('2026-01-01T10:00:00Z');
const make = () =>
  newApproval({
    companyId: company,
    kind: 'journal_post',
    resourceRef: 'journal:123',
    payload: { amount: '1000.00' },
    requesterId: requester,
    expiresAt: new Date(T0.getTime() + 24 * 3_600_000),
    now: T0,
  });

describe('user status machine (A-04)', () => {
  it('allows the lifecycle transitions', () => {
    expect(transitionUserStatus('pending', 'active')).toBe('active');
    expect(transitionUserStatus('active', 'suspended')).toBe('suspended');
    expect(transitionUserStatus('suspended', 'active')).toBe('active');
    expect(transitionUserStatus('active', 'active')).toBe('active');
  });
  it('rejects pending-less loops', () => {
    expect(() => transitionUserStatus('active', 'pending')).toThrow(DomainError);
    expect(() => transitionUserStatus('suspended', 'pending')).toThrow(DomainError);
  });
});

describe('approval state machine', () => {
  it('forbids self-approval and self-rejection (A-03)', () => {
    expect(() => approve(make(), requester, null, T0)).toThrowError(
      expect.objectContaining({ kind: 'SELF_APPROVAL_FORBIDDEN' }),
    );
    expect(() => reject(make(), requester, null, T0)).toThrowError(
      expect.objectContaining({ kind: 'SELF_APPROVAL_FORBIDDEN' }),
    );
  });
  it('approves a pending request immutably', () => {
    const a = make();
    const b = approve(a, approver, 'ok', T0);
    expect(b).toMatchObject({
      status: 'approved',
      approverId: approver,
      comment: 'ok',
      decidedAt: T0,
    });
    expect(a.status).toBe('pending');
  });
  it('only pending requests can be decided (A-04)', () => {
    const decided = approve(make(), approver, null, T0);
    expect(() => reject(decided, approver, null, T0)).toThrowError(
      expect.objectContaining({ kind: 'INVALID_STATE_TRANSITION' }),
    );
    expect(() => approve(decided, approver, null, T0)).toThrow(DomainError);
  });
  it('refuses to decide after expiry and expireIfDue flips pending → expired', () => {
    const late = new Date(T0.getTime() + 25 * 3_600_000);
    expect(() => approve(make(), approver, null, late)).toThrow(DomainError);
    expect(expireIfDue(make(), late).status).toBe('expired');
    expect(expireIfDue(make(), T0).status).toBe('pending');
    const done = approve(make(), approver, null, T0);
    expect(expireIfDue(done, late)).toBe(done);
  });
});
