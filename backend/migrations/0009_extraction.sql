-- LexAudit AI — 0009_extraction.sql (Step B10): AI çıxarışı, hesab kodu təklifi, hesablar planı

CREATE TABLE chart_of_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    standard VARCHAR(4) NOT NULL DEFAULT 'MMUS' CHECK (standard IN ('MMUS', 'MHBS')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, name)
);
CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    chart_id UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE CASCADE,
    code VARCHAR(10) NOT NULL CHECK (code ~ '^[0-9]{3,6}$'),
    name_az TEXT NOT NULL,
    name_ru TEXT,
    name_en TEXT,
    type VARCHAR(12) NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense', 'off_balance')),
    parent_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    UNIQUE (chart_id, code)
);
ALTER TABLE companies ADD CONSTRAINT fk_companies_chart FOREIGN KEY (chart_of_accounts_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;

-- AI nəticələri: model versiyası və sahə səviyyəsində etibarlılıq (UI < 0.85 sahələri sarı göstərir)
ALTER TABLE invoices ADD COLUMN field_confidence JSONB NOT NULL DEFAULT '{}';
ALTER TABLE invoices ADD COLUMN ai_model_version VARCHAR(100);
ALTER TABLE invoice_lines ADD COLUMN account_suggestion_confidence NUMERIC(4, 3)
    CHECK (account_suggestion_confidence IS NULL OR (account_suggestion_confidence >= 0 AND account_suggestion_confidence <= 1));
ALTER TABLE invoice_lines ADD COLUMN ai_model_version VARCHAR(100);

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['chart_of_accounts', 'accounts'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format($p$
            CREATE POLICY tenant_isolation_%1$s ON %1$I AS PERMISSIVE FOR ALL
            USING (current_setting('app.current_company_id', true) IS NULL OR current_setting('app.current_company_id', true) = ''
                   OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::UUID)$p$, t);
    END LOOP;
END $$;
