-- LexAudit AI — 0001_init.sql (Step B2)
-- Database schema for Identity, RBAC, Sessions, Immutable Audit, and Approvals
-- Azerbaijani localization extensions: unaccent, pg_trgm, vector, pgcrypto

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- 1. COMPANIES (Tenant root)
CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    voen VARCHAR(10) NOT NULL UNIQUE,
    base_currency VARCHAR(3) NOT NULL DEFAULT 'AZN',
    is_vat_payer BOOLEAN NOT NULL DEFAULT true,
    tax_regime VARCHAR(20) NOT NULL DEFAULT 'general' CHECK (tax_regime IN ('general', 'simplified')),
    reporting_standard VARCHAR(20) NOT NULL DEFAULT 'MMUS' CHECK (reporting_standard IN ('MMUS', 'MHBS')),
    chart_of_accounts_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_companies_voen ON companies(voen);

-- 2. USERS
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended')),
    mfa_secret VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 3. RBAC: ROLES, PERMISSIONS, ROLE_PERMISSIONS, USER_ROLES
CREATE TABLE IF NOT EXISTS roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, role_id)
);

-- 4. SESSIONS (Refresh token tracking, rotation & revocation)
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    ip VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_refresh_hash ON sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id) WHERE revoked_at IS NULL;

-- 5. AUDIT_EVENTS (Strictly Append-Only)
CREATE TABLE IF NOT EXISTS audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100) NOT NULL,
    resource_id VARCHAR(255) NOT NULL,
    before JSONB,
    after JSONB,
    request_id VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_company_created ON audit_events(company_id, created_at DESC);

-- §4.1: audit_events — yalnız INSERT (UPDATE/DELETE DB səviyyəsində qadağan)
CREATE OR REPLACE FUNCTION trg_prevent_audit_events_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only: UPDATE and DELETE are strictly prohibited (Audit A-13 / §4.1)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_events_immutable ON audit_events;
CREATE TRIGGER trg_audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW
EXECUTE FUNCTION trg_prevent_audit_events_modification();

-- 6. APPROVALS (§4.1 & Audit A-03: approver_id <> requester_id)
CREATE TABLE IF NOT EXISTS approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    kind VARCHAR(100) NOT NULL,
    resource_ref VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    requester_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    approver_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    expires_at TIMESTAMPTZ NOT NULL,
    decided_at TIMESTAMPTZ,
    comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_approver_diff_requester CHECK (approver_id IS NULL OR approver_id <> requester_id)
);

CREATE INDEX IF NOT EXISTS idx_approvals_company_status ON approvals(company_id, status);

-- 7. Multi-tenant Row Level Security (RLS) setup
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation_users' AND tablename = 'users'
    ) THEN
        CREATE POLICY tenant_isolation_users ON users
            AS PERMISSIVE FOR ALL
            USING (
                current_setting('app.current_company_id', true) IS NULL OR
                current_setting('app.current_company_id', true) = '' OR
                company_id = NULLIF(current_setting('app.current_company_id', true), '')::UUID
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation_sessions' AND tablename = 'sessions'
    ) THEN
        CREATE POLICY tenant_isolation_sessions ON sessions
            AS PERMISSIVE FOR ALL
            USING (
                current_setting('app.current_company_id', true) IS NULL OR
                current_setting('app.current_company_id', true) = '' OR
                company_id = NULLIF(current_setting('app.current_company_id', true), '')::UUID
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation_audit' AND tablename = 'audit_events'
    ) THEN
        CREATE POLICY tenant_isolation_audit ON audit_events
            AS PERMISSIVE FOR ALL
            USING (
                current_setting('app.current_company_id', true) IS NULL OR
                current_setting('app.current_company_id', true) = '' OR
                company_id = NULLIF(current_setting('app.current_company_id', true), '')::UUID
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation_approvals' AND tablename = 'approvals'
    ) THEN
        CREATE POLICY tenant_isolation_approvals ON approvals
            AS PERMISSIVE FOR ALL
            USING (
                current_setting('app.current_company_id', true) IS NULL OR
                current_setting('app.current_company_id', true) = '' OR
                company_id = NULLIF(current_setting('app.current_company_id', true), '')::UUID
            );
    END IF;
END
$$;
