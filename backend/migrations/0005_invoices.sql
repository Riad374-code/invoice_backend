-- LexAudit AI — 0005_invoices.sql (Step B6)
CREATE TABLE counterparties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL,
    voen VARCHAR(10),
    country VARCHAR(2) NOT NULL DEFAULT 'AZ',
    is_vat_payer BOOLEAN,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_counterparties_company_voen ON counterparties (company_id, voen) WHERE voen IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('sales', 'purchase')),
    number VARCHAR(100) NOT NULL,
    issue_date DATE NOT NULL,
    counterparty_id UUID REFERENCES counterparties(id) ON DELETE RESTRICT,
    currency CHAR(3) NOT NULL DEFAULT 'AZN',
    net NUMERIC(18, 2) NOT NULL,
    vat NUMERIC(18, 2) NOT NULL,
    gross NUMERIC(18, 2) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'extracted'
        CHECK (status IN ('extracted', 'needs_review', 'validated', 'posted')),
    source_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
    extraction_confidence NUMERIC(4, 3) CHECK (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1)),
    template_version VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_invoices_company_issue_date ON invoices (company_id, issue_date);
CREATE INDEX idx_invoices_company_number ON invoices (company_id, direction, number);

CREATE TABLE invoice_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    description TEXT NOT NULL,
    qty NUMERIC(18, 3) NOT NULL,
    unit_price NUMERIC(18, 4) NOT NULL,
    vat_rate_code VARCHAR(60) NOT NULL,
    net NUMERIC(18, 2) NOT NULL,
    vat NUMERIC(18, 2) NOT NULL,
    account_suggestion VARCHAR(10),
    account_final VARCHAR(10),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (invoice_id, line_no)
);

CREATE TABLE invoice_issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    code VARCHAR(40) NOT NULL,
    severity VARCHAR(10) NOT NULL CHECK (severity IN ('error', 'warning')),
    detail TEXT NOT NULL,
    line_no INTEGER,
    field VARCHAR(60),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_invoice_issues_invoice ON invoice_issues (invoice_id);

CREATE TABLE import_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    source VARCHAR(10) NOT NULL CHECK (source IN ('1c', 'etaxes', 'bank')),
    template_version VARCHAR(50),
    file_id UUID REFERENCES files(id) ON DELETE SET NULL,
    rows_ok INTEGER NOT NULL DEFAULT 0,
    rows_failed INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['counterparties', 'invoices', 'invoice_lines', 'invoice_issues', 'import_jobs'] LOOP
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
