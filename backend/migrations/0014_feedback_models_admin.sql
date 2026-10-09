-- LexAudit AI — 0014_feedback_models_admin.sql (Step B14)

CREATE TABLE model_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    version VARCHAR(50) NOT NULL,
    kind VARCHAR(12) NOT NULL CHECK (kind IN ('llm', 'embedding', 'classifier')),
    artifact_uri TEXT NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'canary', 'production', 'retired')),
    eval_report JSONB,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (name, version)
);
-- Hər növ üçün eyni anda yalnız BİR production modeli
CREATE UNIQUE INDEX uq_model_versions_one_production ON model_versions (kind) WHERE status = 'production';

-- Anonim feedback export: hansı hadisələr artıq göndərilib
ALTER TABLE feedback_events ADD COLUMN exported_at TIMESTAMPTZ;
CREATE INDEX idx_feedback_unexported ON feedback_events (created_at) WHERE exported_at IS NULL;
CREATE TABLE feedback_exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    storage_key TEXT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    rows INTEGER NOT NULL,
    from_ts TIMESTAMPTZ,
    to_ts TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO permissions (code, description) VALUES
    ('platform:admin', 'Platform operator: global sources, tax rates and model versions (only effective in the platform company)')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'platform:admin' WHERE r.company_id IS NULL AND r.name = 'admin'
ON CONFLICT DO NOTHING;
