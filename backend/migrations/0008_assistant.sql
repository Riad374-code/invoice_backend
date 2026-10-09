-- LexAudit AI — 0008_assistant.sql (Step B9): söhbətlər, alət icraları, rəy, valyuta məzənnələri

CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title VARCHAR(200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_conversations_user ON conversations (company_id, user_id, updated_at DESC);

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role VARCHAR(10) NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    citations JSONB NOT NULL DEFAULT '[]',
    -- assistant mesajında modelin təklif etdiyi alət çağırışları; tool mesajında tool_call_id
    tool_calls JSONB,
    tool_call_id VARCHAR(100),
    -- §13: hər AI nəticəsi ilə model versiyası (izlənə bilmə və rollback üçün)
    model_version VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_messages_model_version CHECK (role <> 'assistant' OR model_version IS NOT NULL)
);
CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at, id);

CREATE TABLE tool_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    tool_name VARCHAR(100) NOT NULL,
    requested_args JSONB,
    validated_args JSONB,
    status VARCHAR(20) NOT NULL CHECK (status IN ('running', 'rejected', 'approval_required', 'succeeded', 'failed')),
    reject_reason VARCHAR(30),
    error TEXT,
    result_summary TEXT,
    approval_id UUID REFERENCES approvals(id) ON DELETE SET NULL,
    duration_ms INTEGER,
    idempotency_key VARCHAR(100),
    request_id VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tool_runs_company_created ON tool_runs (company_id, created_at DESC);
CREATE INDEX idx_tool_runs_idem ON tool_runs (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_tool_runs_approval ON tool_runs (approval_id) WHERE approval_id IS NOT NULL;

-- Model təlimi üçün məlumat mənbəyi (B14 anonim export edəcək)
CREATE TABLE feedback_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    invoice_line_id UUID REFERENCES invoice_lines(id) ON DELETE SET NULL,
    journal_line_id UUID,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('thumbs', 'correction', 'approval_decision')),
    before JSONB,
    after JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_feedback_target CHECK (num_nonnulls(message_id, invoice_line_id, journal_line_id) >= 1)
);
CREATE INDEX idx_feedback_company ON feedback_events (company_id, created_at DESC);

-- CBAR rəsmi məzənnələri (qlobal istinad məlumatı; gündəlik yükləmə B12-də)
CREATE TABLE fx_rates (
    currency CHAR(3) NOT NULL,
    date DATE NOT NULL,
    rate NUMERIC(18, 6) NOT NULL CHECK (rate > 0),
    nominal INTEGER NOT NULL DEFAULT 1 CHECK (nominal >= 1),
    source VARCHAR(20) NOT NULL DEFAULT 'CBAR',
    PRIMARY KEY (currency, date, source)
);

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['conversations', 'messages', 'tool_runs', 'feedback_events'] LOOP
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

INSERT INTO permissions (code, description) VALUES
    ('assistant:use', 'Use the AI assistant (conversations, feedback)')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'assistant:use'
WHERE r.company_id IS NULL AND r.name IN ('admin', 'accountant', 'approver', 'viewer')
ON CONFLICT DO NOTHING;
