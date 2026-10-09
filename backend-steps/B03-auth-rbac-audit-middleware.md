# B3 — Auth + RBAC + audit middleware

> Mənbə: `BACKEND.md` §15 İnkişaf ardıcıllığı
> Orijinal sətir (dəyişdirilmədən):
> `| B3 | Auth + RBAC + audit middleware | Login, refresh, icazə |`
> Tam BACKEND.md: `../BACKEND.md`

Bu addımın nəticəsi: **Login, refresh, icazə**.

---

## 1. Bu addıma aid orijinal tələblər (BACKEND.md-dən olduğu kimi)

### §2 Texnologiya — Auth sətri (olduğu kimi):
| Sahə | Seçim |
|---|---|
| Auth | **argon2** (şifrə), **jsonwebtoken** (access token 15 dəq), refresh token DB-də (hash), brauzerə `HttpOnly; Secure; SameSite=Strict` cookie kimi verilir + CSRF token |
| Pul | **rust_decimal** — `f64` qadağandır |
| Validasiya | **validator** / **garde** |

### §4.1-dən B3-ə aid cədvəllər (olduğu kimi):
| Cədvəl | Əsas sahələr |
|---|---|
| `users` | email, password_hash, status, mfa_secret |
| `roles`, `permissions`, `role_permissions`, `user_roles` | |
| `sessions` | refresh_token_hash, expires_at, revoked_at, ip, user_agent |
| `audit_events` | actor_id, action, resource_type, resource_id, before, after, request_id — **yalnız INSERT** (UPDATE/DELETE DB səviyyəsində qadağan) |

### §4 giriş (olduğu kimi):
> Bütün cədvəllərdə: `id UUID`, `company_id UUID` (tenant), `created_at`, `updated_at`, lazım olanda `deleted_at` (soft delete).
> `company_id` **həmişə sessiyadan** götürülür, heç vaxt request body-dən və ya model arqumentindən (multi-tenant təhlükəsizliyi). Postgres **Row Level Security** əlavə qoruma kimi.

### §5 API — Auth qrupu (olduğu kimi):
| Qrup | Endpoint-lər (nümunə) |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /me` |

### §5 Xəta formatı və kodlar (olduğu kimi):
```json
{ "error": { "code": "NOT_FOUND", "message": "Invoice not found", "requestId": "req_…" } }
```
Kodlar: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT`, `APPROVAL_REQUIRED`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `INTERNAL`.

### §11 Təhlükəsizlik — B3-ə aid bütün sətirlər (olduğu kimi):
| Qayda | Audit |
|---|---|
| Şifrə Argon2id, login rate limit, 2FA (istəyə bağlı) | A-01 |
| Hər handler-də `RequireAuth` + `RequirePermission` extractor | A-02 |
| Token müddəti dinamik, refresh rotation | A-07 |
| Lock/DB xətası → `5xx`, heç vaxt saxta uğur | A-13 |
| PII maskalama log-larda (VÖEN, FİN, IBAN, telefon) | |
| Fayl yükləmə: ölçü limiti, MIME yoxlaması, antivirus (ClamAV) | |
| Şifrə Argon2id ilə bağlı tam qayda yuxarıdakı kimidir. | |

Əlavə §11 sətirləri (B3 kontekstində qorunmalıdır, olduğu kimi):
- Secret-lər yalnız env/secret manager; start-da yoxlanır
- CORS: yalnız konkret origin-lər

### §3 Qovluq — aid hissə (olduğu kimi):
```
│   │       ├── middleware/       # auth, request_id, rate_limit, idempotency, cors
│   │       ├── error.rs          # ApiError → {error:{code,message,requestId}}
│   │       └── routes/           # auth, invoices, vat, ledger, excel, recon, news,
```

### §16 Qəbul — B3-ə aid (olduğu kimi):
- Heç bir endpoint auth/icazə yoxlamasız deyil (avtomatik test ilə yoxlanır)
- Bütün yazma əməliyyatları `audit_events`-də görünür

---

## 2. Detallı görüləcək işlər

### 2.1 Auth endpoints (`/api/v1` prefiksi ilə)
- [ ] `POST /auth/login` — email+şifrə, Argon2id yoxlama, login rate limit, 2FA (istəyə bağlı, `mfa_secret` varsa). Uğurda: access token (15 dəq, `jsonwebtoken`) + refresh token (DB-də hash ilə `sessions`-da saxla) → brauzerə `HttpOnly; Secure; SameSite=Strict` cookie + CSRF token.
- [ ] `POST /auth/refresh` — refresh rotation, müddət dinamik, köhnə token revoke (`revoked_at`), `ip, user_agent` yaz.
- [ ] `POST /auth/logout` — refresh revoke.
- [ ] `GET /me` — cari istifadəçi + rollar.
- [ ] Validasiya: `validator` / `garde` ilə.
- [ ] Pul ilə iş yoxdur, amma `f64` qadağası ümumi qayda kimi qalır.

### 2.2 RBAC
- [ ] Hər handler-də `RequireAuth` + `RequirePermission` extractor (A-02).
- [ ] `roles, permissions, role_permissions, user_roles` ilə yoxlama.
- [ ] `company_id` həmişə sessiyadan (heç vaxt body-dən).
- [ ] İcazəsiz → `FORBIDDEN`, authsuz → `UNAUTHENTICATED`.

### 2.3 Audit middleware
- [ ] Bütün yazma əməliyyatları `audit_events`-də görünür (`actor_id, action, resource_type, resource_id, before, after, request_id`).
- [ ] PII maskalama log-larda (VÖEN, FİN, IBAN, telefon).
- [ ] Lock/DB xətası → `5xx`, heç vaxt saxta uğur (A-13).

### 2.4 Test
- [ ] Hər endpoint üçün 401/403 halları; heç bir endpoint auth/icazəsiz deyil — avtomatik test ilə.

---

## 3. Yaradılacaq / dəyişdiriləcək fayllar
```
backend/crates/api/src/routes/auth.rs (POST /auth/login, POST /auth/refresh, POST /auth/logout, GET /me)
backend/crates/api/src/middleware/auth.rs
backend/crates/api/src/middleware/rate_limit.rs
backend/crates/api/src/middleware/request_id.rs
backend/crates/db/src/sessions.rs (əgər yoxdursa)
backend/crates/audit/src/ (middleware-dən çağırılır)
```

---

## 4. Qəbul meyarı
- Login → refresh → logout axını işləyir, cookie `HttpOnly; Secure; SameSite=Strict` + CSRF token.
- Access token 15 dəq, refresh rotation işləyir.
- İcazəsiz sorğu `403 FORBIDDEN`, authsuz `401 UNAUTHENTICATED`.
- Bütün yazmalar `audit_events`-də.
