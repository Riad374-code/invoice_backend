-- LexAudit AI — 0013_impact.sql (Step B13): təsir analizi, bildirişlər, platforma şirkəti

CREATE TABLE impact_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    -- news_or_version_id: xəbər id-si və ya legislation_versions.id
    source_kind VARCHAR(20) NOT NULL CHECK (source_kind IN ('news', 'legislation_version')),
    source_id UUID NOT NULL,
    affected_resource_type VARCHAR(12) NOT NULL CHECK (affected_resource_type IN ('file', 'audit')),
    affected_resource_id UUID NOT NULL,
    score NUMERIC(4, 3) NOT NULL CHECK (score >= 0 AND score <= 1),
    explanation TEXT NOT NULL,
    evidence JSONB NOT NULL DEFAULT '[]',
    status VARCHAR(10) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'dismissed', 'actioned')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- eyni mənbə + eyni sənəd üçün bir tapıntı (job təkrarı dublikat yaratmasın)
    UNIQUE (company_id, source_kind, source_id, affected_resource_type, affected_resource_id)
);
CREATE INDEX idx_impact_company_status ON impact_findings (company_id, status, score DESC);

CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind VARCHAR(30) NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    ref_type VARCHAR(30),
    ref_id UUID,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    seq BIGSERIAL
);
CREATE INDEX idx_notifications_user ON notifications (user_id, seq DESC);
CREATE UNIQUE INDEX uq_notifications_ref ON notifications (user_id, kind, ref_id) WHERE ref_id IS NOT NULL;

-- Platforma operatoru şirkəti: qlobal istinad məlumatını (vergi dərəcələri) yalnız onun təsdiq axını aktivləşdirir
ALTER TABLE companies ADD COLUMN is_platform BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX uq_companies_single_platform ON companies (is_platform) WHERE is_platform;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['impact_findings', 'notifications'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format($p$
            CREATE POLICY tenant_isolation_%1$s ON %1$I AS PERMISSIVE FOR ALL
            USING (current_setting('app.current_company_id', true) IS NULL OR current_setting('app.current_company_id', true) = ''
                   OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::UUID)$p$, t);
    END LOOP;
END $$;

INSERT INTO permissions (code, description) VALUES
    ('impact:read', 'Read impact findings and notifications'),
    ('impact:write', 'Update impact finding status')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON (
    (p.code = 'impact:read' AND r.name IN ('admin', 'accountant', 'approver', 'viewer')) OR
    (p.code = 'impact:write' AND r.name IN ('admin', 'accountant')))
WHERE r.company_id IS NULL
ON CONFLICT DO NOTHING;
