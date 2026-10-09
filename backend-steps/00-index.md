# Backend addımlar — ümumi xəritə (BACKEND.md §15)

> Mənbə: `BACKEND.md` §15 İnkişaf ardıcıllığı — orijinal cədvəl dəyişdirilmədən:
> | # | Addım | Nəticə |
> |---|---|---|
> | B1 | Workspace, config, Docker Compose, health, tracing, CI | Server açılır |
> | B2 | Migrations: identity, audit, approvals | |
> | B3 | Auth + RBAC + audit middleware | Login, refresh, icazə |
> | B4 | Files + S3 + extraction job skeleti | |
> | B5 | `accounting` crate + golden testlər | ƏDV, depozit hesabı, jurnal |
> | B6 | Invoices: XML parse, validasiya, issues | |
> | B7 | Sources + news + legislation ingestion, versiyalama | |
> | B8 | Chunks + embedding + hybrid search + rerank | RAG |
> | B9 | LLM client + Agent + Tool Gateway + SSE | Assistent |
> | B10 | PDF/OCR çıxarışı + hesab kodu təklifi | |
> | B11 | VAT periods + bəyannamə qaralaması + ledger | |
> | B12 | Excel jobs + reconciliation + 1C / e-taxes / bank import | |
> | B13 | Impact analysis + bildirişlər | |
> | B14 | Feedback export + model versiyaları + admin | |
> | B15 | Yük testi, təhlükəsizlik yoxlaması, release | |

## Fayllar
- `B01-workspace-config-compose-health-ci.md` → B1
- `B02-migrations-identity-audit-approvals.md` → B2
- `B03-auth-rbac-audit-middleware.md` → B3
- `B04-files-s3-extraction-skeleton.md` → B4
- `B05-accounting-crate-golden-tests.md` → B5
- `B06-invoices-xml-validation-issues.md` → B6
- `B07-sources-news-legislation-ingestion.md` → B7
- `B08-chunks-embedding-hybrid-search-rerank.md` → B8
- `B09-llm-agent-tool-gateway-sse.md` → B9
- `B10-pdf-ocr-account-suggest.md` → B10
- `B11-vat-periods-return-ledger.md` → B11
- `B12-excel-reconciliation-import.md` → B12
- `B13-impact-analysis-notifications.md` → B13
- `B14-feedback-modelversions-admin.md` → B14
- `B15-load-security-release.md` → B15

## Tamlıq zəmanəti
- Hər faylın §1-də orijinal BACKEND.md mətni olduğu kimi köçürülüb (cədədvlər, kod blokları, qaydalar).
- Heç bir sətir dəyişdirilməyib və ya silinməyib; yalnız aid olduğu B addımına paylanıb.
- Orijinal ardıcıllıq B1→B15 qorunub; hər faylda `Yaradılacaq fayllar` və `Qəbul meyarı` var.
- Tam mənbə: `../BACKEND.md` (423 sətir).


---

## Stack dəyişikliyi: Rust → TypeScript + Fastify
Addım fayllarının §1 hissəsi orijinal (Rust) mətni saxlayır. İcra zamanı bu xəritə tətbiq olunur (ətraflı: `../BACKEND.md` §2–§3):

| Rust (addım fayllarında) | TypeScript (icra) |
|---|---|
| `crates/<ad>/src/x.rs` | `backend/src/<ad>/x.ts` |
| Axum + tower middleware | Fastify 5 plugin/hook (`src/plugins/`) |
| `RequireAuth` / `RequirePermission` extractor | `config: { public \| authOnly \| permission }` route elanı (elan yoxdursa boot olmur) |
| SQLx + `cargo sqlx prepare` | `pg` + parametrli SQL repository-lər (`src/db/repos/`), `migrations/*.sql` |
| `rust_decimal` / `f64` qadağası | `decimal.js` / `number` ilə pul qadağası |
| `validator` / `garde` | `zod` (+ OpenAPI) |
| `utoipa` | `@fastify/swagger` + zod → `openapi.json` |
| `jsonwebtoken` / `argon2` crate | `jose` / `argon2` |
| `calamine`, `rust_xlsxwriter` | `exceljs` |
| `quick-xml` | `fast-xml-parser` |
| `reqwest` + `scraper` | `fetch` + `cheerio` |
| `proptest` / `insta` / `testcontainers` | `fast-check` / vitest snapshot / PGlite (+ CI Postgres servisi) |
| `cargo clippy -D warnings` + `cargo test` | `tsc --noEmit` + `eslint` + `prettier --check` + `vitest run` |

## İcra statusu
| Addım | Status | Qeyd |
|---|---|---|
| B1 | ✅ | server açılır, `/admin/health` (DB yoxlayır), typed config, tracing/metrics/OTel, OpenAPI, CI, Dockerfile + compose |
| B2 | ✅ | `0001_init.sql` (RLS, append-only trigger, `approver<>requester` CHECK) + `0002_seed_rbac.sql`; domain/db/audit modulları |
| B3 | ✅ | login/refresh(rotation + reuse detection)/logout/csrf/me, TOTP, RBAC, rate limit, idempotency, audit |
| B4 | ✅ | files + S3 (content-addressed, sha256 dedupe), ClamAV, magic-byte MIME, Postgres job queue + cron, extraction pipeline skeleti |
| B5 | ✅ | accounting mühərriki (vat, withholding, vat-deposit, journal, fx, tax-id, invoice, rounding), `tax_rates` + GET /tax-rates, ~1000 golden (BigInt referans), property testlər |
| B6 | ✅ | invoices (+ counterparties, lines, issues, import_jobs), etaxes-v1 XML şablon parser, validate/propose-entries, state machine |
| B7 | ✅ | sources (9 başlanğıc, deaktiv), SafeFetcher (SSRF/robots/rate-limit), RSS/HTML adapterləri, news dedupe, qanun versiyalama (EXCLUDE overlap), news/legislation API, alerts |
| B8 | ✅ | chunks (HNSW+GIN, az_normalize), chunker, embedding/rerank klientləri, hybrid search+RRF, tarix/tenant/icazə filtri, sitat doğrulaması, POST /search |
| B9 | ✅ | LLM klienti (stream+tools), Tool Gateway (7 addım), 17 alət reyestri (11 aktiv), orkestrator (sitat/grounding/limitlər), SSE, təsdiq → icra, feedback |
| B10 | ✅ | mətnli PDF (unpdf) + OCR, extract_invoice müqaviləsi (zod), sahə etibarlılığı < 0.85 → needs_review, account_suggestion (account_final boş), mhbs.classify, insan düzəlişi → feedback |
| B11–B15 | ⏳ | |
