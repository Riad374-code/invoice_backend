-- LexAudit AI — 0011_vat_ledger.sql (Step B11): jurnal, ƏDV dövrləri/bəyannamə, depozit, vergi təqvimi

-- ------------------------------------------------------------------ jurnal
CREATE TABLE journal_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    entry_date DATE NOT NULL,
    description TEXT NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'posted')),
    source VARCHAR(10) NOT NULL CHECK (source IN ('invoice', 'manual', 'ai')),
    source_invoice_id UUID REFERENCES invoices(id) ON DELETE RESTRICT,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    approval_id UUID REFERENCES approvals(id) ON DELETE SET NULL,
    approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    posted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_je_posted CHECK ((status = 'posted') = (posted_at IS NOT NULL)),
    CONSTRAINT chk_je_invoice_source CHECK (source <> 'invoice' OR source_invoice_id IS NOT NULL)
);
CREATE INDEX idx_journal_entries_company_date ON journal_entries (company_id, entry_date DESC, id);
-- Bir qaimə yalnız BİR dəfə mühasibatlaşdırıla bilər
CREATE UNIQUE INDEX uq_je_invoice_booked ON journal_entries (source_invoice_id) WHERE status IN ('approved', 'posted');

CREATE TABLE journal_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL,
    account_code VARCHAR(10) NOT NULL CHECK (account_code ~ '^[0-9]{3,6}$'),
    account_id UUID REFERENCES accounts(id) ON DELETE RESTRICT,
    debit NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
    description TEXT,
    UNIQUE (entry_id, line_no),
    -- hər sətir yalnız bir tərəfdə və sıfırdan böyük
    CONSTRAINT chk_jl_one_side CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);

-- Balanssız yazılış təsdiqlənə/post oluna bilməz (DB səviyyəsində, tətbiqdən asılı olmayaraq)
CREATE OR REPLACE FUNCTION trg_je_balanced_on_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d NUMERIC; c NUMERIC; n INTEGER;
BEGIN
    IF NEW.status IN ('approved', 'posted') AND (TG_OP = 'INSERT' OR OLD.status = 'proposed') THEN
        SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0), COUNT(*) INTO d, c, n FROM journal_lines WHERE entry_id = NEW.id;
        IF n < 2 OR d <> c THEN
            RAISE EXCEPTION 'journal entry % is not balanced (debit %, credit %, % lines)', NEW.id, d, c, n USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER je_balanced_on_approval BEFORE INSERT OR UPDATE OF status ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION trg_je_balanced_on_approval();

-- Təsdiqlənmiş/post olunmuş yazılış və sətirləri dəyişməzdir (düzəliş yalnız yeni əks yazılışla)
CREATE OR REPLACE FUNCTION trg_je_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'journal_entries' THEN
        IF TG_OP = 'DELETE' AND OLD.status <> 'proposed' THEN
            RAISE EXCEPTION 'journal entry % is % and cannot be deleted', OLD.id, OLD.status USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.status <> 'proposed' AND (
            NEW.status <> OLD.status AND NOT (OLD.status = 'approved' AND NEW.status = 'posted')
            OR NEW.entry_date <> OLD.entry_date OR NEW.description <> OLD.description OR NEW.company_id <> OLD.company_id) THEN
            RAISE EXCEPTION 'journal entry % is % and is immutable', OLD.id, OLD.status USING ERRCODE = '23514';
        END IF;
        RETURN COALESCE(NEW, OLD);
    END IF;
    -- journal_lines
    IF (SELECT status FROM journal_entries WHERE id = COALESCE(NEW.entry_id, OLD.entry_id)) <> 'proposed' THEN
        RAISE EXCEPTION 'lines of a non-proposed journal entry are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER je_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION trg_je_immutable();
CREATE TRIGGER jl_immutable BEFORE INSERT OR UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION trg_je_immutable();

-- ------------------------------------------------------------ ƏDV dövrü/bəyannamə
CREATE TABLE vat_periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    period CHAR(7) NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'draft', 'filed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, period)
);
CREATE TABLE vat_returns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    period_id UUID NOT NULL REFERENCES vat_periods(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version >= 1),
    output_vat NUMERIC(18, 2) NOT NULL,
    input_vat NUMERIC(18, 2) NOT NULL,
    exempt_turnover NUMERIC(18, 2) NOT NULL,
    zero_rated_turnover NUMERIC(18, 2) NOT NULL,
    -- output − input: mənfi = geri qaytarılan/keçirilən ƏDV
    payable NUMERIC(18, 2) NOT NULL,
    deposit_balance NUMERIC(18, 2),
    status VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
    draft_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
    summary JSONB NOT NULL DEFAULT '{}',
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (period_id, version)
);

-- ------------------------------------------------------------------ depozit
CREATE TABLE vat_deposit_statements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    period CHAR(7) NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    source_file_id UUID REFERENCES files(id) ON DELETE SET NULL,
    imported_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE vat_deposit_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    statement_id UUID NOT NULL REFERENCES vat_deposit_statements(id) ON DELETE CASCADE,
    line_date DATE NOT NULL,
    operation VARCHAR(12) NOT NULL CHECK (operation IN ('top_up', 'vat_payment', 'refund', 'withdrawal', 'other')),
    amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
    reference VARCHAR(100),
    counterparty_voen VARCHAR(10),
    matched_invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL
);
CREATE INDEX idx_vat_deposit_lines_stmt ON vat_deposit_lines (statement_id, line_date);

-- ------------------------------------------------------------ vergi təqvimi
-- Son tarixlər kodda deyil, burada (qlobal istinad məlumatı)
CREATE TABLE tax_calendar (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tax_type VARCHAR(20) NOT NULL CHECK (tax_type IN ('VAT', 'PROFIT', 'INCOME', 'WITHHOLDING', 'SIMPLIFIED', 'SOCIAL')),
    period VARCHAR(10) NOT NULL,
    due_date DATE NOT NULL,
    legal_source_id UUID REFERENCES legislation_documents(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tax_type, period)
);

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['journal_entries', 'journal_lines', 'vat_periods', 'vat_returns', 'vat_deposit_statements', 'vat_deposit_lines'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format($p$
            CREATE POLICY tenant_isolation_%1$s ON %1$I AS PERMISSIVE FOR ALL
            USING (current_setting('app.current_company_id', true) IS NULL OR current_setting('app.current_company_id', true) = ''
                   OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::UUID)$p$, t);
    END LOOP;
END $$;
