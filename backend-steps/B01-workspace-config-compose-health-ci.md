# B1 — Workspace, config, Docker Compose, health, tracing, CI

> Mənbə: `BACKEND.md` §15 İnkişaf ardıcıllığı
> Orijinal sətir (dəyişdirilmədən):
> `| B1 | Workspace, config, Docker Compose, health, tracing, CI | Server açılır |`
> Tam BACKEND.md: `../BACKEND.md` (423 sətir, §1–§16)

Bu addımın nəticəsi: **Server açılır**.

---

## 1. Bu addıma aid orijinal tələblər (BACKEND.md-dən olduğu kimi)

### §1 Məqsəd və məsuliyyətlər — aid hissə
> Backend sistemin **yeganə həqiqət mənbəyidir**

### §2 Texnologiya — B1-ə aid sətirlər (olduğu kimi):
| Sahə | Seçim |
|---|---|
| Dil | **Rust** (stable) |
| Web framework | **Axum** + **tower** middleware |
| Async runtime | **Tokio** |
| DB | **PostgreSQL 16** + **pgvector** + `pg_trgm` + `unaccent` (Azərbaycan və rus dili mətn axtarışı; `ə, ı, ğ, ş, ç, ö, ü` normallaşdırması) |
| DB layer | **SQLx** (compile-time yoxlanan sorğular), migrations |
| OpenAPI | **utoipa** → frontend tip generasiyası |
| Logging/tracing | **tracing**, OpenTelemetry, Prometheus metrics |
| Test | `cargo test`, **testcontainers** (real Postgres), **insta** (snapshot) |
| Deploy | Docker Compose (dev), Kubernetes/on-prem (prod) — məlumat Azərbaycan daxilində saxlanılır ("Fərdi məlumatlar haqqında" Qanun) |

### §3 Qovluq strukturu — B1-ə aid hissə (olduğu kimi):
```
backend/
├── BACKEND.md
├── Cargo.toml                    # workspace
├── Cargo.lock                    # COMMIT olunur (audit A-19)
├── .env.example
├── docker-compose.yml            # postgres+pgvector, minio, model-serving (dev)
├── migrations/                   # SQLx migrations (0001_init.sql, ...)
├── crates/
│   ├── api/                      # Axum server: router, handlers, middleware, OpenAPI
│   │   └── src/
│   │       ├── main.rs
│   │       ├── config.rs         # typed config, eksik secret → start olmur
│   │       ├── router.rs
│   │       ├── middleware/       # auth, request_id, rate_limit, idempotency, cors
│   │       ├── error.rs          # ApiError → {error:{code,message,requestId}}
│   │       └── routes/           # auth, invoices, vat, ledger, excel, recon, news,
│   │                             # legislation, files, assistant, approvals, audit, admin
└── tests/
    ├── integration/
    └── golden/                   # ƏDV/qaimə qızıl test faylları
```

### §5 API — B1-ə aid baza qaydalar (olduğu kimi):
- Prefiks: `/api/v1`. Bütün cavablar JSON; pul məbləğləri **string**. Yazma sorğularında `Idempotency-Key`.
- Xəta formatı:
```json
{ "error": { "code": "NOT_FOUND", "message": "Invoice not found", "requestId": "req_…" } }
```
- Kodlar: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT`, `APPROVAL_REQUIRED`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `INTERNAL`.
- Admin nümunə: `/admin/health` (§5 Admin sətrindən: `/admin/users`, `/admin/roles`, `/admin/sources`, `/admin/tax-rates`, `/admin/models`, `/admin/health`)

### §11 Təhlükəsizlik — B1-ə aid sətirlər (olduğu kimi):
| Qayda | Audit |
|---|---|
| Secret-lər yalnız env/secret manager; start-da yoxlanır | |
| CORS: yalnız konkret origin-lər | |

### §16 Qəbul meyarları — B1-ə aid sətir (olduğu kimi):
- `cargo clippy -D warnings`, `cargo test`, integration testlər CI-da yaşıl
- OpenAPI sxemi generasiya olunur və frontend tipləri onunla sinxrondur

---

## 2. Detallı görüləcək işlər

### 2.1 Cargo workspace
- [ ] `backend/Cargo.toml` — workspace təyin et, bütün crate-ləri `crates/*` üzrə əlavə et (hələlik boş olsa belə `api` üzvü).
- [ ] `backend/Cargo.lock` — COMMIT olunur (audit A-19). Heç vaxt `.gitignore`-a salma.
- [ ] Rust stable toolchain pinlə (`rust-toolchain.toml` tövsiyə olunur).

### 2.2 Config
- [ ] `crates/api/src/config.rs` — typed config:
  - Bütün secret-lər env/secret manager-dən oxunur.
  - Eksik secret → **start olmur** (panic/early exit, §3-dəki şərh olduğu kimi: `typed config, eksik secret → start olmur`).
- [ ] `.env.example` — bütün env dəyişənlərinin nümunəsi, real secret YOXDUR.

### 2.3 Docker Compose (dev)
- [ ] `docker-compose.yml` — servislər (olduğu kimi):
  - `postgres+pgvector` (PostgreSQL 16 + pgvector + `pg_trgm` + `unaccent`)
  - `minio` (S3-uyğun)
  - `model-serving` (dev üçün stub/servis)
- [ ] Məlumat Azərbaycan daxilində saxlanılır prinsipi prod üçün qeyd olunur.

### 2.4 Axum server skeleti
- [ ] `crates/api/src/main.rs` — Tokio runtime, tracing init, config yüklə, router başlat.
- [ ] `crates/api/src/router.rs` — `/api/v1` prefiksi, `/admin/health` endpointi.
- [ ] `crates/api/src/middleware/` — 5 middleware faylı/qovluğu:
  - `auth`, `request_id`, `rate_limit`, `idempotency`, `cors` (CORS yalnız konkret origin-lər).
- [ ] `crates/api/src/error.rs` — `ApiError → {error:{code,message,requestId}}` formatı, §5-dəki 9 kod ilə.
- [ ] `crates/api/src/routes/` — qovluqları yarat: `auth, invoices, vat, ledger, excel, recon, news, legislation, files, assistant, approvals, audit, admin` (hələlik stub ola bilər).

### 2.5 Tracing / Metrics / OpenAPI
- [ ] `tracing` + OpenTelemetry + Prometheus metrics qoş.
- [ ] `utoipa` ilə OpenAPI generasiyası — frontend tip generasiyasına hazır olsun.

### 2.6 CI
- [ ] CI pipeline: `cargo clippy -D warnings`, `cargo test`, integration testlər.
- [ ] `tests/integration/` və `tests/golden/` qovluqlarını yarat (boş olsa belə).

---

## 3. Yaradılacaq fayl/qovluqlar (yoxlama siyahısı)
```
backend/Cargo.toml
backend/Cargo.lock (commit)
backend/.env.example
backend/docker-compose.yml
backend/migrations/
backend/crates/api/src/main.rs
backend/crates/api/src/config.rs
backend/crates/api/src/router.rs
backend/crates/api/src/middleware/
backend/crates/api/src/error.rs
backend/crates/api/src/routes/
backend/tests/integration/
backend/tests/golden/
```

---

## 4. Qəbul meyarı (bu addım üçün)
- Server `docker-compose up` ilə açılır, `/api/v1/admin/health` və ya `/admin/health` cavab verir.
- Eksik secret ilə start olmur.
- Xəta cavabı `{error:{code,message,requestId}}` formatındadır.
- `cargo clippy -D warnings` və `cargo test` yaşıl.
- `Cargo.lock` commit olunub.
