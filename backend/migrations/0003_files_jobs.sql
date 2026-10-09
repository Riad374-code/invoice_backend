-- LexAudit AI — 0003_files_jobs.sql (Step B4)
-- Files (S3 metadata), versions (sha256 dedupe), extractions (pipeline status) + Postgres job queue.

-- 1. FILES
CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL,
    mime VARCHAR(127) NOT NULL,
    size BIGINT NOT NULL CHECK (size >= 0),
    folder VARCHAR(500) NOT NULL DEFAULT '/',
    tags TEXT[] NOT NULL DEFAULT '{}',
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_files_company_folder ON files (company_id, folder) WHERE deleted_at IS NULL;
CREATE INDEX idx_files_company_created ON files (company_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_files_tags ON files USING GIN (tags);
CREATE INDEX idx_files_name_trgm ON files USING GIN (name gin_trgm_ops);

-- 2. FILE VERSIONS (content-addressed: eyni sha256 → eyni storage_key)
CREATE TABLE file_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    version_no INTEGER NOT NULL CHECK (version_no >= 1),
    storage_key VARCHAR(500) NOT NULL,
    sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size BIGINT NOT NULL CHECK (size >= 0),
    mime VARCHAR(127) NOT NULL,
    uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (file_id, version_no)
);
CREATE INDEX idx_file_versions_company_sha ON file_versions (company_id, sha256);

-- 3. FILE EXTRACTIONS (pipeline: pending → extracting → ready | failed)
CREATE TABLE file_extractions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    file_version_id UUID NOT NULL UNIQUE REFERENCES file_versions(id) ON DELETE CASCADE,
    detected_kind VARCHAR(40),
    text TEXT,
    layout_json JSONB,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'extracting', 'ready', 'failed')),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_file_extractions_company_status ON file_extractions (company_id, status);

-- 4. JOBS (Postgres əsaslı növbə: FOR UPDATE SKIP LOCKED)
CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
    queue VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
    run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at TIMESTAMPTZ,
    locked_by VARCHAR(100),
    last_error TEXT,
    result JSONB,
    idempotency_key VARCHAR(200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);
CREATE INDEX idx_jobs_claim ON jobs (run_at, created_at) WHERE status = 'queued';
CREATE INDEX idx_jobs_running ON jobs (locked_at) WHERE status = 'running';
-- Eyni növbədə eyni açarla ikinci iş yaranmır (cron tick-ləri, təkrar upload cəhdləri)
CREATE UNIQUE INDEX uq_jobs_idempotency ON jobs (queue, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 5. Multi-tenant RLS (əlavə qoruma; bax: 0001_init.sql)
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['files', 'file_versions', 'file_extractions'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format($p$
            CREATE POLICY tenant_isolation_%1$s ON %1$I AS PERMISSIVE FOR ALL
            USING (
                current_setting('app.current_company_id', true) IS NULL OR
                current_setting('app.current_company_id', true) = '' OR
                company_id = NULLIF(current_setting('app.current_company_id', true), '')::UUID
            )$p$, t);
    END LOOP;
END $$;

-- 6. İcazələr
INSERT INTO permissions (code, description) VALUES
    ('files:read',  'Read files and their extraction status'),
    ('files:write', 'Upload, edit, archive and reindex files')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (
    (p.code = 'files:read'  AND r.name IN ('admin', 'accountant', 'approver', 'viewer'))
    OR (p.code = 'files:write' AND r.name IN ('admin', 'accountant'))
)
WHERE r.company_id IS NULL
ON CONFLICT DO NOTHING;
