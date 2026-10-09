-- LexAudit AI — 0007_chunks.sql (Step B8): RAG parçaları (pgvector + full-text)

-- Azərbaycan hərflərini (ə ı ö ü ç ş ğ + noqtəli İ) ASCII-ə endirən deterministik normalizator.
-- IMMUTABLE olmalıdır ki, generated column / indeksdə istifadə olunsun.
CREATE OR REPLACE FUNCTION az_normalize(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT translate(replace(lower(t), U&'\0307', ''), 'əıöüçşğ', 'eioucsg')
$$;

CREATE TABLE chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL = qlobal məzmun (qanun, xəbər); dəyər = yalnız həmin şirkətə aid (file, audit)
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
    resource_type VARCHAR(12) NOT NULL CHECK (resource_type IN ('legislation', 'news', 'file', 'audit')),
    resource_id UUID NOT NULL,
    -- legislation → legislation_versions.id ; file → file_versions.id ; digərləri NULL
    version_id UUID,
    chunk_no INTEGER NOT NULL CHECK (chunk_no >= 0),
    article_ref VARCHAR(120),
    jurisdiction VARCHAR(5) NOT NULL DEFAULT 'AZ',
    language VARCHAR(5),
    text TEXT NOT NULL,
    embedding vector(1024),
    embedding_model VARCHAR(100),
    embedded_at TIMESTAMPTZ,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', az_normalize(text))) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- şirkət məzmunu qlobal ola bilməz, qlobal məzmun şirkətə bağlanmaz
    CONSTRAINT chk_chunks_scope CHECK (
        (resource_type IN ('file', 'audit') AND company_id IS NOT NULL) OR
        (resource_type IN ('legislation', 'news') AND company_id IS NULL)
    )
);
CREATE UNIQUE INDEX uq_chunks_resource_chunk ON chunks (resource_type, resource_id, COALESCE(version_id, '00000000-0000-0000-0000-000000000000'::uuid), chunk_no);
CREATE INDEX idx_chunks_company ON chunks (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX idx_chunks_resource ON chunks (resource_type, resource_id);
CREATE INDEX idx_chunks_pending_embedding ON chunks (created_at) WHERE embedding IS NULL;
CREATE INDEX idx_chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_chunks_tsv ON chunks USING GIN (tsv);

ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_chunks ON chunks AS PERMISSIVE FOR ALL
    USING (company_id IS NULL
           OR current_setting('app.current_company_id', true) IS NULL OR current_setting('app.current_company_id', true) = ''
           OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::UUID);
