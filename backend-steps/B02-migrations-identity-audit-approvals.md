# B2 — Migrations: identity, audit, approvals

> Mənbə: `BACKEND.md` §15 İnkişaf ardıcıllığı
> Orijinal sətir (dəyişdirilmədən):
> `| B2 | Migrations: identity, audit, approvals | |`
> Tam BACKEND.md: `../BACKEND.md` (§4, §3, §2-dən detallar aşağıda olduğu kimi köçürülüb)

---

## 1. Bu addıma aid orijinal tələblər (BACKEND.md-dən olduğu kimi)

### §4 Verilənlər bazası sxemi — giriş (olduğu kimi):
> Bütün cədvəllərdə: `id UUID`, `company_id UUID` (tenant), `created_at`, `updated_at`, lazım olanda `deleted_at` (soft delete).
> `company_id` **həmişə sessiyadan** götürülür, heç vaxt request body-dən və ya model arqumentindən (multi-tenant təhlükəsizliyi). Postgres **Row Level Security** əlavə qoruma kimi.

### §4.1 Identity və təhlükəsizlik (olduğu kimi):
| Cədvəl | Əsas sahələr |
|---|---|
| `companies` | name, voen, base_currency (default `AZN`), is_vat_payer, tax_regime (`general`/`simplified`), reporting_standard (`MMUS`/`MHBS`), chart_of_accounts_id |
| `users` | email, password_hash, status, mfa_secret |
| `roles`, `permissions`, `role_permissions`, `user_roles` | |
| `sessions` | refresh_token_hash, expires_at, revoked_at, ip, user_agent |
| `audit_events` | actor_id, action, resource_type, resource_id, before, after, request_id — **yalnız INSERT** (UPDATE/DELETE DB səviyyəsində qadağan) |
| `approvals` | kind, resource_ref, payload, requester_id, approver_id, status (enum), expires_at, decided_at, comment — CHECK: `approver_id <> requester_id` |

### §3 Qovluq strukturu — aid hissə (olduğu kimi):
```
├── migrations/                   # SQLx migrations (0001_init.sql, ...)
├── crates/
│   ├── db/                       # repository-lər (SQLx)
│   ├── domain/                   # biznes tipləri, enum-lar, state machine-lər (IO yoxdur)
│   └── audit/                    # dəyişməz audit log yazıcı
```

### §2 Texnologiya — aid sətirlər (olduğu kimi):
| Sahə | Seçim |
|---|---|
| DB | **PostgreSQL 16** + **pgvector** + `pg_trgm` + `unaccent` (Azərbaycan və rus dili mətn axtarışı; `ə, ı, ğ, ş, ç, ö, ü` normallaşdırması) |
| DB layer | **SQLx** (compile-time yoxlanan sorğular), migrations |

### §4 sonu indekslər — aid hissə (olduğu kimi, B2-yə aid olan):
> İndekslər: `chunks` üzərində HNSW (`vector_cosine_ops`) + GIN (`tsv`); `invoices(company_id, issue_date)`; `news_items(canonical_url)` unique; `audit_events(company_id, created_at)`.
- B2 üçün buradan: `audit_events(company_id, created_at)` indeksi.

### §11 Təhlükəsizlik — B2-yə aid sətirlər (olduğu kimi):
| Qayda | Audit |
|---|---|
| `approver_id <> requester_id` (DB CHECK + kod) | A-03 |
| Status = Rust enum + state machine; etibarsız keçid → `409 CONFLICT` | A-04 |

---

## 2. Detallı görüləcək işlər

### 2.1 Migrations
- [ ] `migrations/0001_init.sql` (və lazım olsa `0002_...sql`):
  - `companies` — yuxarıdakı sahələrin hamısı, `base_currency` default `AZN`, `tax_regime` (`general`/`simplified`), `reporting_standard` (`MMUS`/`MHBS`).
  - `users` — `email, password_hash, status, mfa_secret` + standart `id UUID, company_id UUID, created_at, updated_at, deleted_at`.
  - `roles, permissions, role_permissions, user_roles` — RBAC cədvəlləri.
  - `sessions` — `refresh_token_hash, expires_at, revoked_at, ip, user_agent`.
  - `audit_events` — `actor_id, action, resource_type, resource_id, before, after, request_id` + **yalnız INSERT**: UPDATE/DELETE DB səviyyəsində qadağan (REVOKE / trigger / RLS policy ilə).
  - `approvals` — `kind, resource_ref, payload, requester_id, approver_id, status (enum), expires_at, decided_at, comment` + CHECK: `approver_id <> requester_id`.
- [ ] Bütün cədvəllərdə standart sahələr: `id UUID, company_id UUID, created_at, updated_at`, lazım olanda `deleted_at`.
- [ ] RLS aktivləşdir: `company_id` sessiyadan gələcək, əlavə qoruma kimi Postgres Row Level Security.
- [ ] İndeks: `audit_events(company_id, created_at)`.
- [ ] SQLx compile-time yoxlanan sorğular ilə işlədiyini təsdiqlə (`cargo sqlx prepare` / offline mode).

### 2.2 `domain` crate
- [ ] `crates/domain/` — biznes tiplər, enum-lar, state machine-lər. **IO yoxdur** (§3 Qayda).
- [ ] Status enum-ları: `approvals.status`, `users.status` — Rust enum kimi, etibarsız keçid → `409 CONFLICT`.

### 2.3 `db` crate
- [ ] `crates/db/` — repository-lər (SQLx) — `companies, users, roles, sessions, audit_events, approvals` üçün CRUD.

### 2.4 `audit` crate
- [ ] `crates/audit/` — dəyişməz audit log yazıcı (yalnız INSERT yazır, UPDATE/DELETE etmir).

---

## 3. Yaradılacaq fayl/qovluqlar
```
backend/migrations/0001_init.sql
backend/crates/domain/
backend/crates/db/
backend/crates/audit/
```

---

## 4. Qəbul meyarı
- Migration-lar təmiz DB-də tətbiq olunur və geri qaytarılmadan irəli gedir.
- `audit_events`-ə UPDATE/DELETE cəhdi DB səviyyəsində rədd olunur.
- `approvals`-da `approver_id = requester_id` CHECK ilə rədd olunur.
- `company_id` heç vaxt request body-dən götürülmür (kod review ilə).
