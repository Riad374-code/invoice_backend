-- LexAudit AI — 0006_ingestion.sql (Step B7)
-- Xəbər və qanunvericilik: QLOBAL istinad məlumatı (şirkətə aid deyil). İstifadəçiyə aid yalnız oxundu/seçilmiş vəziyyətidir.

CREATE TABLE sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL UNIQUE,
    url TEXT NOT NULL,
    type VARCHAR(10) NOT NULL CHECK (type IN ('official', 'news')),
    -- Mənbənin təbiəti: news ingestion → news_items, legislation → legislation_*
    kind VARCHAR(15) NOT NULL DEFAULT 'news' CHECK (kind IN ('news', 'legislation')),
    -- rss | html_list | html_document ; selektorlar config-dədir (hər sayt üçün təsdiqlənməlidir)
    adapter VARCHAR(20) CHECK (adapter IN ('rss', 'html_list', 'html_document')),
    config JSONB NOT NULL DEFAULT '{}',
    fetch_cron VARCHAR(100) NOT NULL DEFAULT '0 * * * *',
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE fetch_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    status VARCHAR(10) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
    items_new INTEGER NOT NULL DEFAULT 0,
    items_seen INTEGER NOT NULL DEFAULT 0,
    error TEXT
);
CREATE INDEX idx_fetch_runs_source_started ON fetch_runs (source_id, started_at DESC);

CREATE TABLE news_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    original_url TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    content_hash CHAR(64) NOT NULL,
    published_at TIMESTAMPTZ,
    -- raw_text AI çıxışından AYRIDIR və dəyişdirilmir
    raw_text TEXT NOT NULL,
    ai_summary TEXT,
    ai_category VARCHAR(60),
    ai_risk_level VARCHAR(20),
    ai_tags TEXT[],
    ai_model_version VARCHAR(100),
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_news_items_canonical_url ON news_items (canonical_url);
CREATE INDEX idx_news_items_published ON news_items (published_at DESC NULLS LAST, id DESC);
CREATE INDEX idx_news_items_hash ON news_items (content_hash);

CREATE TABLE news_user_state (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    news_item_id UUID NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    read_at TIMESTAMPTZ,
    bookmarked BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, news_item_id)
);
ALTER TABLE news_user_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_news_user_state ON news_user_state AS PERMISSIVE FOR ALL
    USING (current_setting('app.current_company_id', true) IS NULL OR current_setting('app.current_company_id', true) = ''
           OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::UUID);

CREATE TABLE legislation_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID REFERENCES sources(id) ON DELETE SET NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('code', 'law', 'decree', 'cabinet_decision', 'standard')),
    official_number VARCHAR(100),
    adopted_at DATE,
    title TEXT NOT NULL,
    language VARCHAR(5) NOT NULL DEFAULT 'az',
    source_url TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_legislation_documents_canonical ON legislation_documents (canonical_url);
CREATE INDEX idx_legislation_documents_title_trgm ON legislation_documents USING GIN (title gin_trgm_ops);

CREATE TABLE legislation_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES legislation_documents(id) ON DELETE CASCADE,
    version_no INTEGER NOT NULL CHECK (version_no >= 1),
    valid_from DATE NOT NULL,
    valid_to DATE,
    full_text TEXT NOT NULL,
    source_url TEXT NOT NULL,
    content_hash CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (document_id, version_no),
    CONSTRAINT chk_leg_version_period CHECK (valid_to IS NULL OR valid_to >= valid_from),
    -- Eyni sənədin versiyaları tarixən üst-üstə düşə bilməz (tarixə görə "qüvvədə olan versiya" birmənalıdır)
    CONSTRAINT excl_leg_versions_overlap EXCLUDE USING gist (document_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&)
);

-- hüquqi əsas: tax_rates artıq qanun sənədinə bağlana bilər
ALTER TABLE tax_rates ADD CONSTRAINT fk_tax_rates_legal_source FOREIGN KEY (legal_source_id) REFERENCES legislation_documents(id) ON DELETE SET NULL;

-- Sistem xəbərdarlıqları (məs. mənbə 24 saatdır yenilənmir)
CREATE TABLE system_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind VARCHAR(40) NOT NULL,
    source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);
-- Eyni mənbə üçün eyni növdə yalnız BİR açıq xəbərdarlıq
CREATE UNIQUE INDEX uq_system_alerts_open ON system_alerts (kind, source_id) WHERE resolved_at IS NULL;

-- İcazələr
INSERT INTO permissions (code, description) VALUES
    ('news:read', 'Read news items and manage own read/bookmark state'),
    ('legislation:read', 'Read legislation documents, versions and diffs')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('news:read', 'legislation:read')
WHERE r.company_id IS NULL AND r.name IN ('admin', 'accountant', 'approver', 'viewer')
ON CONFLICT DO NOTHING;

-- Başlanğıc mənbələr (BACKEND.md §8.1). Hamısı DEACTIVE: hər sayt üçün adapter/selektorlar yoxlanıb
-- təsdiqlənənədək fetch işləmir (robots.txt və istifadə şərtlərinə riayət üçün insan təsdiqi).
INSERT INTO sources (name, url, type, kind, fetch_cron) VALUES
    ('e-qanun.az', 'https://e-qanun.az', 'official', 'legislation', '0 */6 * * *'),
    ('Dövlət Vergi Xidməti (taxes.gov.az)', 'https://www.taxes.gov.az', 'official', 'news', '*/30 * * * *'),
    ('Maliyyə Nazirliyi (MMUS, Hesablar Planı)', 'https://www.maliyye.gov.az', 'official', 'news', '0 * * * *'),
    ('Azərbaycan Mərkəzi Bankı (CBAR)', 'https://www.cbar.az', 'official', 'news', '0 * * * *'),
    ('Milli Məclis', 'https://meclis.gov.az', 'official', 'legislation', '0 */6 * * *'),
    ('Nazirlər Kabineti', 'https://cabmin.gov.az', 'official', 'legislation', '0 */6 * * *'),
    ('Azərbaycan Respublikasının Prezidenti', 'https://president.az', 'official', 'legislation', '0 */6 * * *'),
    ('Dövlət Sosial Müdafiə Fondu (DSMF)', 'https://www.dsmf.gov.az', 'official', 'news', '0 * * * *'),
    ('IFRS Foundation', 'https://www.ifrs.org', 'news', 'news', '0 */4 * * *')
ON CONFLICT (name) DO NOTHING;
