-- LexAudit AI — 0002_seed_rbac.sql (Step B3)
-- Sistem icazələri və qlobal rollar (company_id IS NULL). İdempotentdir.

INSERT INTO permissions (code, description) VALUES
    ('users:read',       'Read user accounts'),
    ('users:write',      'Manage user accounts'),
    ('roles:read',       'Read roles and permissions'),
    ('roles:write',      'Manage roles and permissions'),
    ('invoices:read',    'Read invoices'),
    ('invoices:write',   'Create and update invoices'),
    ('vat:read',         'Read VAT calculations and returns'),
    ('vat:write',        'Manage VAT returns'),
    ('journal:read',     'Read accounting journal entries'),
    ('journal:write',    'Submit accounting journal entries'),
    ('approvals:read',   'List approval requests'),
    ('approvals:decide', 'Decide on approval requests'),
    ('audit:read',       'Read immutable audit logs'),
    ('admin:health',     'Check system health and metrics')
ON CONFLICT (code) DO NOTHING;

-- Qlobal rolların adı unikal olmalıdır (roles.name üzərində company_id NULL üçün)
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_global_name ON roles (name) WHERE company_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_company_name ON roles (company_id, name) WHERE company_id IS NOT NULL;

INSERT INTO roles (company_id, name, description) VALUES
    (NULL, 'admin',      'System administrator with all permissions'),
    (NULL, 'accountant', 'Works with invoices, VAT and journal entries'),
    (NULL, 'approver',   'Reviews and decides approval requests'),
    (NULL, 'viewer',     'Read-only access to accounting data')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (
    r.name = 'admin'
    OR (r.name = 'accountant' AND p.code IN (
        'invoices:read', 'invoices:write', 'vat:read', 'vat:write',
        'journal:read', 'journal:write', 'approvals:read'))
    OR (r.name = 'approver' AND p.code IN (
        'invoices:read', 'vat:read', 'journal:read', 'approvals:read', 'approvals:decide'))
    OR (r.name = 'viewer' AND p.code IN (
        'invoices:read', 'vat:read', 'journal:read'))
)
WHERE r.company_id IS NULL
ON CONFLICT DO NOTHING;
