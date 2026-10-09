import { DomainError } from './errors.js';

export const TAX_REGIMES = ['general', 'simplified'] as const;
export type TaxRegime = (typeof TAX_REGIMES)[number];

export const REPORTING_STANDARDS = ['MMUS', 'MHBS'] as const;
export type ReportingStandard = (typeof REPORTING_STANDARDS)[number];

export const USER_STATUSES = ['pending', 'active', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface Company {
  id: string;
  name: string;
  voen: string;
  baseCurrency: string;
  isVatPayer: boolean;
  taxRegime: TaxRegime;
  reportingStandard: ReportingStandard;
  chartOfAccountsId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface User {
  id: string;
  companyId: string;
  email: string;
  passwordHash: string;
  status: UserStatus;
  mfaSecret: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Role {
  id: string;
  /** null = bütün şirkətlər üçün sistem rolu */
  companyId: string | null;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Permission {
  id: string;
  code: string;
  description: string | null;
  createdAt: Date;
}

export interface Session {
  id: string;
  companyId: string;
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function isSessionActive(session: Session, now: Date): boolean {
  return session.revokedAt === null && session.expiresAt.getTime() > now.getTime();
}

const ALLOWED_USER_TRANSITIONS: Record<UserStatus, readonly UserStatus[]> = {
  pending: ['active', 'suspended'],
  active: ['suspended'],
  suspended: ['active'],
};

/** A-04: status = enum + state machine; etibarsız keçid → 409 CONFLICT. */
export function transitionUserStatus(from: UserStatus, to: UserStatus): UserStatus {
  if (from === to) return to;
  if (!ALLOWED_USER_TRANSITIONS[from].includes(to)) {
    throw new DomainError(
      'INVALID_STATE_TRANSITION',
      `Disallowed user status transition ${from} -> ${to}`,
    );
  }
  return to;
}

/** Sistem icazə kodları (permissions cədvəli ilə sinxron — migrations/0002_seed_rbac.sql). */
export const PERMISSIONS = {
  USERS_READ: 'users:read',
  USERS_WRITE: 'users:write',
  ROLES_READ: 'roles:read',
  ROLES_WRITE: 'roles:write',
  INVOICES_READ: 'invoices:read',
  INVOICES_WRITE: 'invoices:write',
  VAT_READ: 'vat:read',
  VAT_WRITE: 'vat:write',
  JOURNAL_READ: 'journal:read',
  JOURNAL_WRITE: 'journal:write',
  APPROVALS_READ: 'approvals:read',
  APPROVALS_DECIDE: 'approvals:decide',
  AUDIT_READ: 'audit:read',
  FILES_READ: 'files:read',
  FILES_WRITE: 'files:write',
  ASSISTANT_USE: 'assistant:use',
  EXCEL_USE: 'excel:use',
  PLATFORM_ADMIN: 'platform:admin',
  IMPACT_READ: 'impact:read',
  IMPACT_WRITE: 'impact:write',
  IMPORTS_COMMIT: 'imports:commit',
  NEWS_READ: 'news:read',
  LEGISLATION_READ: 'legislation:read',
  ADMIN_HEALTH: 'admin:health',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_DESCRIPTIONS: Record<PermissionCode, string> = {
  'users:read': 'Read user accounts',
  'users:write': 'Manage user accounts',
  'roles:read': 'Read roles and permissions',
  'roles:write': 'Manage roles and permissions',
  'invoices:read': 'Read invoices',
  'invoices:write': 'Create and update invoices',
  'vat:read': 'Read VAT calculations and returns',
  'vat:write': 'Manage VAT returns',
  'journal:read': 'Read accounting journal entries',
  'journal:write': 'Submit accounting journal entries',
  'approvals:read': 'List approval requests',
  'approvals:decide': 'Decide on approval requests',
  'audit:read': 'Read immutable audit logs',
  'files:read': 'Read files and their extraction status',
  'files:write': 'Upload, edit, archive and reindex files',
  'assistant:use': 'Use the AI assistant (conversations, feedback)',
  'excel:use': 'Run Excel jobs, imports and reconciliations',
  'platform:admin': 'Platform operator: global sources, tax rates and model versions',
  'impact:read': 'Read impact findings and notifications',
  'impact:write': 'Update impact finding status',
  'imports:commit': 'Request commit of previewed imports',
  'news:read': 'Read news items and manage own read/bookmark state',
  'legislation:read': 'Read legislation documents, versions and diffs',
  'admin:health': 'Check system health and metrics',
};
