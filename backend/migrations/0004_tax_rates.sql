-- LexAudit AI — 0004_tax_rates.sql (Step B5)
-- Vergi dərəcələri məlumat kimi saxlanılır (kodda sabit YOXDUR); mühərrik onları əməliyyat tarixinə görə seçir.
-- Qlobal istinad məlumatıdır (company_id YOXDUR, RLS YOXDUR): qanun bütün şirkətlər üçün eynidir.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE tax_rates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tax_type VARCHAR(20) NOT NULL
        CHECK (tax_type IN ('VAT', 'PROFIT', 'INCOME', 'WITHHOLDING', 'SIMPLIFIED', 'SOCIAL')),
    code VARCHAR(60) NOT NULL,
    -- Faizlə: 18.0000 = 18%
    rate NUMERIC(9, 4) NOT NULL CHECK (rate >= 0 AND rate <= 100),
    -- Yalnız VAT: tutulan / sıfır dərəcə / azadolma (sıfır dərəcə ≠ azadolma)
    treatment VARCHAR(12) CHECK (treatment IN ('taxable', 'zero_rated', 'exempt')),
    valid_from DATE NOT NULL,
    -- Daxil olmaqla son gün; NULL = açıq
    valid_to DATE,
    -- B7-də legislation_documents yaranandan sonra FK əlavə olunacaq
    legal_source_id UUID,
    status VARCHAR(10) NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'active')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_tax_rates_period CHECK (valid_to IS NULL OR valid_to >= valid_from),
    CONSTRAINT chk_tax_rates_treatment_vat_only CHECK (treatment IS NULL OR tax_type = 'VAT'),
    CONSTRAINT chk_tax_rates_exempt_zero CHECK (treatment IS DISTINCT FROM 'exempt' OR rate = 0),
    -- Eyni (növ, kod) üçün AKTİV dərəcələr tarix baxımından üst-üstə düşə bilməz → mühərrikdə qeyri-müəyyənlik olmaz
    CONSTRAINT excl_tax_rates_active_overlap EXCLUDE USING gist (
        tax_type WITH =,
        code WITH =,
        daterange(valid_from, valid_to, '[]') WITH &&
    ) WHERE (status = 'active')
);

CREATE INDEX idx_tax_rates_lookup ON tax_rates (tax_type, code, valid_from DESC) WHERE status = 'active';
