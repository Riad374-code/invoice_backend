-- LexAudit AI — 0012_excel_recon_import.sql (Step B12)

CREATE TABLE excel_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    input_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
    operation VARCHAR(10) NOT NULL CHECK (operation IN ('profile', 'clean', 'reconcile', 'report')),
    params JSONB NOT NULL DEFAULT '{}',
    output_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
    result JSONB,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE reconciliations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    left_source VARCHAR(100) NOT NULL,
    right_source VARCHAR(100) NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'reviewed')),
    summary JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE reconciliation_matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    reconciliation_id UUID NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
    match_type VARCHAR(20) NOT NULL CHECK (match_type IN ('exact', 'amount_mismatch', 'amount_date', 'unmatched_left', 'unmatched_right')),
    confidence NUMERIC(4, 3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    left_ref JSONB,
    right_ref JSONB,
    difference NUMERIC(18, 2),
    explanation TEXT NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed')),
    confirmed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    confirmed_at TIMESTAMPTZ
);
CREATE INDEX idx_recon_matches ON reconciliation_matches (reconciliation_id);

CREATE TABLE bank_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    import_job_id UUID NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
    tx_date DATE NOT NULL,
    amount NUMERIC(18, 2) NOT NULL CHECK (amount <> 0),
    description TEXT,
    reference VARCHAR(100),
    counterparty_voen VARCHAR(10)
);
CREATE INDEX idx_bank_tx_company_date ON bank_transactions (company_id, tx_date);

-- import: önbaxış (preview) → təsdiq → commit
ALTER TABLE import_jobs DROP CONSTRAINT import_jobs_status_check;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_status_check CHECK (status IN ('pending', 'running', 'done', 'failed', 'previewed', 'committed'));
ALTER TABLE import_jobs ADD COLUMN preview JSONB;
ALTER TABLE import_jobs ADD COLUMN created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE import_jobs ADD COLUMN approval_id UUID REFERENCES approvals(id) ON DELETE SET NULL;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['excel_jobs', 'reconciliations', 'reconciliation_matches', 'bank_transactions'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format($p$
            CREATE POLICY tenant_isolation_%1$s ON %1$I AS PERMISSIVE FOR ALL
            USING (current_setting('app.current_company_id', true) IS NULL OR current_setting('app.current_company_id', true) = ''
                   OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::UUID)$p$, t);
    END LOOP;
END $$;

INSERT INTO permissions (code, description) VALUES
    ('excel:use', 'Run Excel jobs, imports and reconciliations'),
    ('imports:commit', 'Request commit of previewed imports')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('excel:use', 'imports:commit')
WHERE r.company_id IS NULL AND r.name IN ('admin', 'accountant')
ON CONFLICT DO NOTHING;
