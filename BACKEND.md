# LexAudit AI — Backend Planı

> Bu qovluq (`backend/`) əsas server tətbiqini saxlayacaq.
> Frontend: [`../frontend/FRONTEND.md`](../frontend/FRONTEND.md) · Model: [`../model-training/MODEL_TRAINING.md`](../model-training/MODEL_TRAINING.md) · Köhnə kodun səhvləri: [`../audit.md`](../audit.md)

---

## 1. Məqsəd və məsuliyyətlər

Backend sistemin **yeganə həqiqət mənbəyidir**:

- Autentifikasiya, RBAC, təsdiq axını, dəyişməz audit jurnalı
- **Deterministik mühasibat mühərriki:** ƏDV (hesablanmış / əvəzləşdirilən / depozit hesabı), ödəmə mənbəyində vergi, yuvarlaqlaşdırma, valyuta (CBAR), jurnal balansı
- Qaimə, fayl, Excel, jurnal, xəbər, qanunvericilik məlumatlarının saxlanması
- AI Agent orkestratoru və **alət qapısı (Tool Gateway)** — model yalnız təklif edir, server yoxlayıb icra edir
- RAG retrieval (pgvector), mənbələrin (citation) qurulması
- Fon işləri: xəbər/qanun fetch, sənəd çıxarışı, embedding, təsir analizi
- Model xidmətinə (`model-training/serving`) daxili şəbəkə üzərindən müraciət

Backend **LLM-in hesabladığı rəqəmə və ya verdiyi icazəyə heç vaxt etibar etmir**.

---

## 2. Texnologiya

| Sahə | Seçim |
|---|---|
| Dil | **TypeScript** (strict, ESM) — **Node.js 24 LTS** |
| Web framework | **Fastify 5** (plugin/hook modeli, JSON-schema/zod əsaslı validasiya) |
| Runtime | Node.js (async I/O); CPU-ağır işlər (OCR, embedding) model-serving-də |
| DB | **PostgreSQL 16** + **pgvector** + `pg_trgm` + `unaccent` (Azərbaycan və rus dili mətn axtarışı; `ə, ı, ğ, ş, ç, ö, ü` normallaşdırması) |
| DB layer | **node-postgres (`pg`)** + əl ilə yazılmış parametrli SQL repository-lər; SQL migrations (`migrations/*.sql`, checksum-lu, yalnız irəli) |
| Pul | **decimal.js** — `number`/float ilə pul hesablaması qadağandır; məbləğlər API-də **string** |
| Validasiya | **zod** (`fastify-type-provider-zod`) — eyni sxem həm validasiya, həm tip, həm OpenAPI |
| Auth | **argon2id** (şifrə), **jose** (JWT access token 15 dəq), refresh token DB-də (SHA-256 hash), brauzerə `HttpOnly; Secure; SameSite=Strict` cookie kimi verilir + CSRF token (HMAC, sessiyaya bağlı) |
| OpenAPI | **@fastify/swagger** + zod → `openapi.json` → frontend tip generasiyası |
| Fon işləri | Postgres əsaslı növbə (`FOR UPDATE SKIP LOCKED`) + cron (`croner`) |
| Fayl anbarı | **S3-uyğun** (MinIO on-prem, `@aws-sdk/client-s3`) — DB-də yalnız `storage_key` |
| Excel | **exceljs** (oxumaq və yazmaq) |
| XML (e-qaimə, 1C export) | **fast-xml-parser** |
| 1C inteqrasiyası | Excel/XML export-import parser-ləri (versiyalı şablonlar) |
| HTML scraping | Node `fetch` + **cheerio** |
| Logging/tracing | **pino** (Fastify), OpenTelemetry (OTLP), Prometheus (`prom-client`) |
| Test | **vitest**; real Postgres: CI-da servis konteyner, lokal/CI-da **PGlite** (proses daxili Postgres 16 + pgvector + pg_trgm + unaccent); **fast-check** (property-based); vitest snapshot |
| Deploy | Docker Compose (dev), Kubernetes/on-prem (prod) — məlumat Azərbaycan daxilində saxlanılır ("Fərdi məlumatlar haqqında" Qanun) |

---

## 3. Qovluq strukturu (npm paketi, modul sərhədləri `src/` altında)

```
backend/
├── package.json / package-lock.json   # lockfile COMMIT olunur (audit A-19)
├── tsconfig.json  eslint.config.js  vitest.config.ts
├── .env.example
├── Dockerfile  docker-compose.yml     # api + postgres+pgvector + minio + model-serving (dev)
├── openapi.json                       # generasiya olunur (`npm run openapi`), CI-da sinxron yoxlanır
├── migrations/                        # SQL migrations (0001_init.sql, 0002_seed_rbac.sql, ...)
├── src/
│   ├── main.ts                        # giriş nöqtəsi: config → DB → migrate → server
│   ├── app.ts                         # buildApp(): plugin-lər və route-ların yığılması (testlər də istifadə edir)
│   ├── config.ts                      # typed config, eksik secret → start olmur
│   ├── error.ts                       # ApiError → {error:{code,message,requestId}}
│   ├── context.ts                     # AppContext (DI): config, db, repos, audit, rateLimiter
│   ├── plugins/                       # auth (RequireAuth+permission), request-id, rate-limit,
│   │                                  # idempotency, error-handler, audit-guard, metrics
│   ├── routes/                        # auth, invoices, vat, ledger, excel, recon, news,
│   │                                  # legislation, files, assistant, approvals, audit, admin
│   ├── domain/                        # biznes tipləri, enum-lar, state machine-lər (IO yoxdur)
│   ├── accounting/                    # DETERMINISTIK mühərrik (IO yoxdur, 100% test)
│   │   ├── vat.ts                     # ƏDV hesablanması (dərəcə, azadolma, 0%)
│   │   ├── vat-deposit.ts             # ƏDV depozit hesabı ↔ uçot uzlaşdırması
│   │   ├── withholding.ts             # ödəmə mənbəyində vergi
│   │   ├── payroll.ts                 # (Faza 2) gəlir vergisi, DSMF, işsizlik, icbari tibbi sığorta
│   │   ├── rounding.ts                # yuvarlaqlaşdırma qaydaları
│   │   ├── fx.ts                      # valyuta çevirmə (CBAR rəsmi məzənnəsi ilə)
│   │   ├── journal.ts                 # debet = kredit, hesab kodu validasiyası
│   │   ├── tax-id.ts                  # VÖEN (10 rəqəm), FİN (7 simvol), AZ IBAN (28 simvol) format yoxlaması
│   │   └── rates.ts                   # tarixə görə dərəcə seçimi
│   ├── db/                            # Db interfeysi (pg Pool / PGlite), migrate, repos/ (SQL)
│   ├── storage/                       # S3 adapter
│   ├── documents/                     # PDF/şəkil/XML/Excel parse, OCR çağırışı
│   ├── ingestion/                     # xəbər + qanun scraper-ləri, dedupe, versiyalama
│   ├── rag/                           # chunking, embedding client, hybrid search, rerank, citation
│   ├── llm/                           # model-serving client (OpenAI-uyğun API), prompt şablonları
│   ├── agent/                         # orkestrator, tool registry, tool gateway, approvals
│   ├── jobs/                          # fon işləri və cron
│   └── audit/                         # dəyişməz audit log yazıcı + PII maskalama
└── tests/
    ├── helpers/                       # createTestEnv(): PGlite + migrate + seed + app
    ├── integration/                   # DB (migration, immutability, CHECK) və API testləri
    └── golden/                        # ƏDV/qaimə qızıl test faylları
```

**Qayda:** `accounting` və `domain` modulları heç bir IO-dan (DB, HTTP) asılı deyil — təmiz funksiyalar, tam test olunur.

---

## 4. Verilənlər bazası sxemi

Bütün cədvəllərdə: `id UUID`, `company_id UUID` (tenant), `created_at`, `updated_at`, lazım olanda `deleted_at` (soft delete).
`company_id` **həmişə sessiyadan** götürülür, heç vaxt request body-dən və ya model arqumentindən (multi-tenant təhlükəsizliyi). Postgres **Row Level Security** əlavə qoruma kimi.

### 4.1 Identity və təhlükəsizlik
| Cədvəl | Əsas sahələr |
|---|---|
| `companies` | name, voen, base_currency (default `AZN`), is_vat_payer, tax_regime (`general`/`simplified`), reporting_standard (`MMUS`/`MHBS`), chart_of_accounts_id |
| `users` | email, password_hash, status, mfa_secret |
| `roles`, `permissions`, `role_permissions`, `user_roles` | |
| `sessions` | refresh_token_hash, expires_at, revoked_at, ip, user_agent |
| `audit_events` | actor_id, action, resource_type, resource_id, before, after, request_id — **yalnız INSERT** (UPDATE/DELETE DB səviyyəsində qadağan) |
| `approvals` | kind, resource_ref, payload, requester_id, approver_id, status (enum), expires_at, decided_at, comment — CHECK: `approver_id <> requester_id` |

### 4.2 Mühasibat
| Cədvəl | Əsas sahələr |
|---|---|
| `tax_rates` | tax_type (`VAT`, `PROFIT`, `INCOME`, `WITHHOLDING`, `SIMPLIFIED`, `SOCIAL`…), code, rate NUMERIC, valid_from, valid_to, legal_source_id, status (`proposed`/`active`) |
| `chart_of_accounts`, `accounts` | code (məs. 211, 221, 223, 241, 521, 531, 601), name_az/ru/en, type, parent_id |
| `counterparties` | name, voen, country, is_vat_payer |
| `tax_calendar` | tax_type, period, due_date, legal_source_id — son tarixlər kodda deyil, burada |
| `invoices` | direction (sales/purchase), number, issue_date, counterparty_id, currency, net, vat, gross, status (enum), source_file_id, extraction_confidence |
| `invoice_lines` | description, qty, unit_price, vat_rate_code, net, vat, account_suggestion, account_final |
| `invoice_issues` | invoice_id, code (`VAT_RATE_MISMATCH`, `TOTAL_MISMATCH`, `INVALID_TAX_ID`…), severity, detail |
| `journal_entries`, `journal_lines` | date, description, status (`proposed`/`approved`/`posted`), account_id, debit, credit, source (invoice/manual/ai) |
| `vat_periods`, `vat_returns` | period, output_vat, input_vat, exempt_turnover, zero_rated_turnover, payable, deposit_balance, status, draft_file_id |
| `vat_deposit_statements`, `vat_deposit_lines` | dövr, əməliyyat, məbləğ, uyğunlaşdırılmış qaimə/ödəniş |
| `import_jobs` | source (`1c`/`etaxes`/`bank`), template_version, file_id, rows_ok, rows_failed, status |
| `fx_rates` | currency, date, rate, source (`CBAR`) |
| `reconciliations`, `reconciliation_matches` | left_source, right_source, match_type, confidence, status |
| `excel_jobs` | input_file_id, operation, params, output_file_id, status |

### 4.3 Sənədlər
| Cədvəl | Əsas sahələr |
|---|---|
| `files` | name, mime, size, folder, tags, owner_id, archived_at |
| `file_versions` | storage_key, sha256, size, uploaded_by |
| `file_extractions` | text, layout_json, status (`pending/extracting/ready/failed`), error |

### 4.4 Xəbərlər və qanunvericilik (RAG)
| Cədvəl | Əsas sahələr |
|---|---|
| `sources` | name, url, type (`official`/`news`), fetch_cron, enabled |
| `fetch_runs` | source_id, started_at, finished_at, status, items_new, error |
| `news_items` | source_id, original_url, canonical_url, content_hash, published_at, raw_text, **ai_summary**, **ai_category**, **ai_risk_level**, **ai_tags**, ai_model_version |
| `legislation_documents` | type (`code`/`law`/`decree`/`cabinet_decision`/`standard`), official_number, adopted_at, title, language |
| `legislation_versions` | document_id, version_no, valid_from, valid_to, full_text, source_url, content_hash |
| `chunks` | resource_type (`legislation`/`news`/`file`/`audit`), resource_id, version_id, article_ref, text, **embedding vector(1024)**, embedding_model, tsv (full-text) |
| `impact_findings` | news_or_version_id, affected_resource, score, explanation, status |

### 4.5 AI / Agent
| Cədvəl | Əsas sahələr |
|---|---|
| `conversations`, `messages` | role, content, citations JSONB, model_version |
| `tool_runs` | tool_name, requested_args, validated_args, status, result_summary, approval_id, duration_ms, idempotency_key |
| `feedback_events` | message_id / invoice_line_id / journal_line_id, kind (`thumbs`, `correction`, `approval_decision`), before, after, user_id — **model train məlumatının mənbəyi** |
| `model_versions` | name, kind (llm/embedding/classifier), artifact_uri, status (`candidate/canary/production/retired`), eval_report |

İndekslər: `chunks` üzərində HNSW (`vector_cosine_ops`) + GIN (`tsv`); `invoices(company_id, issue_date)`; `news_items(canonical_url)` unique; `audit_events(company_id, created_at)`.

---

## 5. API (REST + SSE)

Prefiks: `/api/v1`. Bütün cavablar JSON; pul məbləğləri **string**. Yazma sorğularında `Idempotency-Key`.

| Qrup | Endpoint-lər (nümunə) |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /me` |
| Invoices | `POST /invoices/upload`, `GET /invoices`, `GET /invoices/{id}`, `PATCH /invoices/{id}`, `POST /invoices/{id}/validate`, `POST /invoices/{id}/propose-entries` |
| VAT | `GET /vat/periods`, `GET /vat/periods/{p}/summary`, `POST /vat/periods/{p}/draft-return`, `GET /tax-rates` |
| Ledger | `GET /journal`, `POST /journal/{id}/submit`, `GET /accounts` |
| Excel | `POST /excel/jobs` (`profile`/`clean`/`reconcile`/`report`), `GET /excel/jobs/{id}` |
| Reconciliation | `POST /reconciliations`, `GET /reconciliations/{id}`, `POST /reconciliations/{id}/matches/{m}/confirm` |
| News | `GET /news`, `GET /news/{id}`, `PUT /news/{id}/read`, `PUT /news/{id}/bookmark` |
| Legislation | `GET /legislation`, `GET /legislation/{id}`, `GET /legislation/{id}/versions`, `GET /legislation/{id}/diff?from=&to=` |
| Search | `POST /search` (hybrid: full-text + vektor) |
| Files | `POST /files`, `GET /files`, `GET /files/{id}`, `PATCH /files/{id}`, `POST /files/{id}/archive`, `POST /files/{id}/reindex` |
| Assistant | `POST /conversations`, `GET /conversations`, `POST /conversations/{id}/messages` → **SSE stream**, `POST /messages/{id}/feedback` |
| Approvals | `GET /approvals`, `POST /approvals/{id}/decide` |
| Audit | `GET /audit-events` |
| Admin | `/admin/users`, `/admin/roles`, `/admin/sources`, `/admin/tax-rates`, `/admin/models`, `/admin/health` |

Xəta formatı:
```json
{ "error": { "code": "NOT_FOUND", "message": "Invoice not found", "requestId": "req_…" } }
```
Kodlar: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT`, `APPROVAL_REQUIRED`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `INTERNAL`.

---

## 6. Mühasibat mühərriki (deterministik)

### 6.1 Prinsiplər
- Bütün hesablamalar `decimal.js` `Decimal` ilə (heç vaxt `number`).
- Dərəcələr kodda **sabit yazılmır**: `tax_rates` cədvəlindən **əməliyyat tarixinə görə** seçilir.
- Yuvarlaqlaşdırma qaydası yurisdiksiyaya görə konfiqurasiya olunur (sətir səviyyəsində və ya cəm səviyyəsində).
- Hər nəticə `explanation` qaytarır: hansı dərəcə, hansı qanun mənbəyi, hansı addımlar.

### 6.2 Funksiyalar
```
vat::calculate(net, rate_code, date) -> VatResult { rate, vat, gross, rate_source_id }
vat::reverse(gross, rate_code, date)               -> VatResult
withholding::calculate(amount, code, date)         -> WithholdingResult   // ödəmə mənbəyində vergi
vat_deposit::reconcile(statement, ledger)          -> Vec<DepositMatch>
journal::validate(lines)                           -> Result<(), JournalError> // Σdebet = Σkredit
journal::from_invoice(invoice, mapping)            -> Vec<JournalLine>       // təklif
tax_id::validate_voen / validate_fin / validate_iban_az
fx::convert(amount, from, to, date)                -> Money
invoice::check(invoice) -> Vec<InvoiceIssue>       // cəm, dərəcə, tarix, VÖEN, dublikat
```

### 6.3 Test
- `tests/golden/` — yüzlərlə real formatlı (anonimləşdirilmiş) qaimə + gözlənilən nəticə
- Property-based testlər (`fast-check`): `gross == net + vat`, jurnal balansı həmişə 0
- Dərəcə dəyişikliyi sərhədləri: dəyişiklik tarixindən bir gün əvvəl/sonra

---

## 7. Sənəd emalı pipeline-ı

```
upload → S3 → file_versions (sha256 dedupe)
      → job: detect type
           ├─ e-qaimə (e-taxes.gov.az export: Excel/XML) → şablon parser → birbaşa parse  (AI yoxdur, 100% dəqiq)
           ├─ 1C export (Excel/XML) → şablon parser → import_jobs
           ├─ PDF (mətnli)  → mətn + layout çıxarışı → model: extract_invoice
           ├─ PDF/şəkil (skan) → OCR (model-serving) → model: extract_invoice
           └─ XLSX/CSV → exceljs → profil
      → invoices / invoice_lines (status = extracted, confidence)
      → accounting::invoice::check → invoice_issues
      → model: suggest_accounts → invoice_lines.account_suggestion
      → chunk + embed → chunks (RAG üçün)
```

Aşağı confidence (məs. < 0.85) olan sahələr UI-da sarı işarələnir və insan yoxlaması tələb olunur.

---

## 8. Xəbər və qanunvericilik ingestion

### 8.1 Mənbələr (başlanğıc)
- **Qanunvericilik:** e-qanun.az (Hüquqi aktların vahid elektron bazası) — Vergi Məcəlləsi, "Mühasibat uçotu haqqında" Qanun, Nazirlər Kabinetinin qərarları
- **Vergi:** taxes.gov.az (Dövlət Vergi Xidməti) — xəbərlər, izahlar, bəyannamə formaları
- **Mühasibat standartları:** Maliyyə Nazirliyi — MMUS, Hesablar Planı
- **Maliyyə bazarı + məzənnə:** CBAR (cbar.az) — gündəlik rəsmi məzənnə, normativ aktlar
- **Qanun layihələri və aktlar:** Milli Məclis, Nazirlər Kabineti, Prezident aktları
- **Sosial sığorta:** DSMF
- **Qlobal:** IFRS Foundation (MHBS) xəbərləri

Rəsmi API olmayan yerlərdə HTML scraping; `robots.txt` və istifadə şərtlərinə riayət, sorğu tezliyi limitli.

### 8.2 Axın
```
cron (source.fetch_cron) → fetch_runs
  → yeni linklər → canonical URL + content_hash dedupe
  → raw_text saxla (AI çıxışından AYRI)
  → model-serving: classify (kateqoriya, risk, teqlər) + summarize
  → chunk + embed
  → qanun mətni isə: əvvəlki versiya ilə diff → legislation_versions (valid_from)
  → impact analysis: yeni chunk-lar ↔ şirkətin files/audits/records chunk-ları (vektor oxşarlığı + rerank)
       → impact_findings → Dashboard bildirişi
  → vergi dərəcəsi dəyişikliyi aşkarlanarsa → tax_rates (status=proposed) + approvals
```

Fetch xətaları `fetch_runs`-a yazılır; mənbə 24 saat yenilənməsə admin-ə xəbərdarlıq.

---

## 9. RAG xidməti

1. **Sorğu yenidən yazılışı** (istəyə bağlı, LLM ilə) + dil aşkarlama
2. **Hybrid retrieval:** pgvector (cosine, top 50) + Postgres full-text (top 50) → RRF ilə birləşmə
3. **Filtrlər:** `company_id`, istifadəçi icazəsi, yurisdiksiya, **tarix** (həmin tarixdə qüvvədə olan versiya)
4. **Rerank** (model-serving) → top 8
5. Kontekst bloku: hər parça `[S1] Mənbə, maddə, versiya` etiketi ilə
6. LLM cavabı → citation-lar `chunks.id`-yə bağlanır; cavabda olmayan mənbəyə istinad edən citation silinir
7. Mənbə tapılmadıqda: "Bu sual üçün bazada mənbə tapılmadı" — hüquqi iddia qadağandır

Retrieve olunan mətn **etibarsız girişdir**: sistem promptunda açıq qeyd + alət icazələrinə təsir edə bilməz.

---

## 10. Agent orkestratoru və Tool Gateway

### 10.1 Axın
```
user message
  → orchestrator: system prompt + tarixçə + alət sxemləri → LLM
  → LLM tool_call təklif edir
  → Tool Gateway:
       1. alət reyestrdə var?
       2. arqumentlər JSON Schema ilə validasiya
       3. company_id sessiyadan əlavə olunur (modeldən YOX)
       4. istifadəçinin icazəsi var?
       5. risk səviyyəsi: read → icra; write → preview + approvals (APPROVAL_REQUIRED)
       6. idempotency key
       7. tool_runs-a yazılır (həmişə, rədd edilsə də)
  → nəticə LLM-ə qaytarılır → final cavab
  → hər addım SSE event kimi frontend-ə
```
Maksimum addım sayı (məs. 8), timeout, token limiti.

### 10.2 Alətlər
| Alət | Risk | Qeyd |
|---|---|---|
| `legislation.search`, `legislation.get`, `legislation.diff` | read | |
| `news.search`, `news.get` | read | |
| `files.search`, `files.read_text` | read | |
| `invoice.get`, `invoice.list`, `invoice.validate` | read | |
| `vat.calculate`, `withholding.calculate`, `fx.convert` | read | Deterministik mühərrik |
| `vat_deposit.reconcile` | read | Depozit hesabı ↔ uçot |
| `import.preview` (1C / e-taxes / bank) | read | İmport önbaxışı |
| `import.commit` | moderate-write | Təsdiq məcburi |
| `onec.export_entries` | low-write | 1C üçün fayl yaradır |
| `vat.period_summary` | read | |
| `ledger.suggest_entries` | read | Yalnız təklif |
| `ledger.submit_entries` | moderate-write | Təsdiq məcburi |
| `excel.profile`, `excel.query` | read | |
| `excel.generate_report` | low-write | Yeni fayl, orijinal dəyişmir |
| `reconcile.run` | low-write | Nəticə təklif kimi |
| `vat_return.draft` | low-write | Qaralama |
| `mhbs.classify` | read | MHBS/MMUS təsnifatı təklifi |

Qadağan: ixtiyari SQL, shell, fayl sistemi yolları, istifadəçi idarəetməsi, kalıcı silmə, toplu yazma.

---

## 11. Təhlükəsizlik (audit dərslərindən)

| Qayda | Audit |
|---|---|
| Şifrə Argon2id, login rate limit, 2FA (istəyə bağlı) | A-01 |
| Hər route-da `config.public` / `authOnly` / `permission` elanı məcburidir (elan yoxdursa server boot olmur) — `RequireAuth` + `RequirePermission` | A-02 |
| `approver_id <> requester_id` (DB CHECK + kod) | A-03 |
| Status = TypeScript union/enum + state machine; etibarsız keçid → `409 CONFLICT` | A-04 |
| Tapılmayan resurs → `404`; fallback yoxdur | A-05 |
| Token müddəti dinamik, refresh rotation | A-07 |
| Lock/DB xətası → `5xx`, heç vaxt saxta uğur | A-13 |
| Secret-lər yalnız env/secret manager; start-da yoxlanır | |
| CORS: yalnız konkret origin-lər | |
| Fayl yükləmə: ölçü limiti, MIME yoxlaması, antivirus (ClamAV) | |
| PII maskalama log-larda (VÖEN, FİN, IBAN, telefon) | |
| Məlumat Azərbaycan daxilində ("Fərdi məlumatlar haqqında" Qanun) | |

---

## 12. Fon işləri (cron)

| İş | Tezlik |
|---|---|
| Xəbər/qanun fetch | Hər mənbə üçün ayrıca (15 dəq – 24 saat) |
| Məzənnə (CBAR) | Gündəlik |
| Embedding növbəsi | Davamlı |
| Təsir analizi | Yeni xəbər/versiya gələndə |
| Bəyannamə tarixi xatırlatması | Gündəlik |
| Feedback export (anonim) → `model-training` | Həftəlik |
| Approval expiry | Saatlıq |
| Mənbə sağlamlığı yoxlaması | Saatlıq |

---

## 13. Model xidməti ilə müqavilə

Backend `model-training/serving`-ə **OpenAI-uyğun** daxili HTTP API ilə müraciət edir (provider dəyişdirmək asan olsun):

| Endpoint | Məqsəd |
|---|---|
| `POST /v1/chat/completions` (stream, tools) | Assistent / agent |
| `POST /v1/embeddings` | RAG |
| `POST /v1/rerank` | RAG |
| `POST /v1/extract/invoice` | Qaimə çıxarışı (JSON schema-ya uyğun) |
| `POST /v1/ocr` | Skan sənədlər |
| `POST /v1/classify/news` | Kateqoriya, risk, teqlər |
| `POST /v1/classify/account` | Hesab kodu təklifi |
| `GET /v1/models` | Aktiv versiyalar |

Hər AI nəticəsi ilə `model_version` saxlanılır (izlənə bilmə və rollback üçün).

---

## 14. Test strategiyası

| Səviyyə | Nə |
|---|---|
| Unit | `accounting`, `domain` — 100% əhatə hədəfi |
| Golden | Qaimə/ƏDV qızıl faylları |
| Integration | real Postgres (PGlite / CI servis konteyneri): repository-lər, RLS, migrations |
| API | Hər endpoint: 200 / 401 / 403 / 404 / 409 / 422 halları |
| Agent | Mock LLM ilə: icazəsiz alət rədd olunur, write → approval, prompt injection testləri |
| Load | k6: qaimə yükləmə və chat |

---

## 15. İnkişaf ardıcıllığı

| # | Addım | Nəticə |
|---|---|---|
| B1 | Workspace, config, Docker Compose, health, tracing, CI | Server açılır |
| B2 | Migrations: identity, audit, approvals | |
| B3 | Auth + RBAC + audit middleware | Login, refresh, icazə |
| B4 | Files + S3 + extraction job skeleti | |
| B5 | `accounting` modulu + golden testlər | ƏDV, depozit hesabı, jurnal |
| B6 | Invoices: XML parse, validasiya, issues | |
| B7 | Sources + news + legislation ingestion, versiyalama | |
| B8 | Chunks + embedding + hybrid search + rerank | RAG |
| B9 | LLM client + Agent + Tool Gateway + SSE | Assistent |
| B10 | PDF/OCR çıxarışı + hesab kodu təklifi | |
| B11 | VAT periods + bəyannamə qaralaması + ledger | |
| B12 | Excel jobs + reconciliation + 1C / e-taxes / bank import | |
| B13 | Impact analysis + bildirişlər | |
| B14 | Feedback export + model versiyaları + admin | |
| B15 | Yük testi, təhlükəsizlik yoxlaması, release | |

---

## 16. Qəbul meyarları

- `tsc --noEmit`, `eslint`, `prettier --check`, `vitest` (unit + integration) CI-da yaşıl
- OpenAPI sxemi generasiya olunur və frontend tipləri onunla sinxrondur
- Heç bir endpoint auth/icazə yoxlamasız deyil (avtomatik test ilə yoxlanır)
- `number`/float pul hesablamasında istifadə olunmur (`Decimal`; ESLint qaydası + testlər)
- Bütün AI çıxışları `model_version` ilə saxlanılır
- Bütün yazma əməliyyatları `audit_events`-də görünür
