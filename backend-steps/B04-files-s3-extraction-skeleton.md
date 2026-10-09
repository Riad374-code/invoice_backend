# B4 — Files + S3 + extraction job skeleti

> Mənbə: `BACKEND.md` §15 İnkişaf ardıcıllığı
> Orijinal sətir (dəyişdirilmədən):
> `| B4 | Files + S3 + extraction job skeleti | |`
> Tam BACKEND.md: `../BACKEND.md`

---

## 1. Bu addıma aid orijinal tələblər (BACKEND.md-dən olduğu kimi)

### §2 Texnologiya — aid sətirlər (olduğu kimi):
| Sahə | Seçim |
|---|---|
| Fayl anbarı | **S3-uyğun** (MinIO on-prem) — DB-də yalnız `storage_key` |
| Fon işləri | **apalis** və ya Postgres əsaslı növbə (`SKIP LOCKED`) + cron |
| Excel | **calamine** (oxumaq), **rust_xlsxwriter** (yazmaq) |
| XML (e-qaimə, 1C export) | **quick-xml** |

### §3 Qovluq — aid hissələr (olduğu kimi):
```
├── docker-compose.yml            # postgres+pgvector, minio, model-serving (dev)
├── crates/
│   ├── db/                       # repository-lər (SQLx)
│   ├── storage/                  # S3 adapter
│   ├── documents/                # PDF/şəkil/XML/Excel parse, OCR çağırışı
│   ├── jobs/                     # fon işləri və cron
```

### §4.3 Sənədlər (olduğu kimi, tam):
| Cədvəl | Əsas sahələr |
|---|---|
| `files` | name, mime, size, folder, tags, owner_id, archived_at |
| `file_versions` | storage_key, sha256, size, uploaded_by |
| `file_extractions` | text, layout_json, status (`pending/extracting/ready/failed`), error |

### §5 API — Files qrupu (olduğu kimi):
| Qrup | Endpoint-lər (nümunə) |
|---|---|
| Files | `POST /files`, `GET /files`, `GET /files/{id}`, `PATCH /files/{id}`, `POST /files/{id}/archive`, `POST /files/{id}/reindex` |

Ümumi API qaydası (olduğu kimi):
> Prefiks: `/api/v1`. Bütün cavablar JSON; pul məbləğləri **string**. Yazma sorğularında `Idempotency-Key`.

### §7 Sənəd emalı pipeline-ı — B4-ə aid skelet hissə (olduğu kimi, tam):
```
upload → S3 → file_versions (sha256 dedupe)
      → job: detect type
           ├─ e-qaimə (e-taxes.gov.az export: Excel/XML) → şablon parser → birbaşa parse  (AI yoxdur, 100% dəqiq)
           ├─ 1C export (Excel/XML) → şablon parser → import_jobs
           ├─ PDF (mətnli)  → mətn + layout çıxarışı → model: extract_invoice
           ├─ PDF/şəkil (skan) → OCR (model-serving) → model: extract_invoice
           └─ XLSX/CSV → calamine → profil
      → invoices / invoice_lines (status = extracted, confidence)
      → accounting::invoice::check → invoice_issues
      → model: suggest_accounts → invoice_lines.account_suggestion
      → chunk + embed → chunks (RAG üçün)
```
> Aşağı confidence (məs. < 0.85) olan sahələr UI-da sarı işarələnir və insan yoxlaması tələb olunur.

Qeyd: B4-də yalnız skelet (upload → S3 → file_versions → job: detect type → file_extractions statusları). Tam parse/B6/B10-da tamamlanır, amma pipeline mətni dəyişdirilmədən saxlanılır.

### §11 Təhlükəsizlik — B4-ə aid (olduğu kimi):
| Qayda | Audit |
|---|---|
| Fayl yükləmə: ölçü limiti, MIME yoxlaması, antivirus (ClamAV) | |

---

## 2. Detallı görüləcək işlər

### 2.1 Storage
- [ ] `crates/storage/` — S3 adapter (MinIO on-prem ilə uyğun). DB-də yalnız `storage_key` saxla.
- [ ] `docker-compose.yml`-də `minio` servisinin işlədiyini yoxla.

### 2.2 DB
- [ ] `files` — `name, mime, size, folder, tags, owner_id, archived_at` + standart `id, company_id, created_at, updated_at, deleted_at`.
- [ ] `file_versions` — `storage_key, sha256, size, uploaded_by`. `sha256` ilə dedupe.
- [ ] `file_extractions` — `text, layout_json, status (pending/extracting/ready/failed), error`.

### 2.3 Documents crate (skelet)
- [ ] `crates/documents/` — `PDF/şəkil/XML/Excel parse, OCR çağırışı` üçün modul skeleti. B4-də `detect type` + `file_extractions` status keçidləri kifayətdir.

### 2.4 Jobs (skelet)
- [ ] `crates/jobs/` — fon işləri və cron skeleti: `apalis` və ya Postgres `SKIP LOCKED` + cron. Job: `detect type` → `file_extractions.status` yenilə.

### 2.5 API
- [ ] `POST /files` — ölçü limiti, MIME yoxlaması, ClamAV, `Idempotency-Key`, S3-ə yüklə, `file_versions` yarat (sha256 dedupe).
- [ ] `GET /files`, `GET /files/{id}`, `PATCH /files/{id}`, `POST /files/{id}/archive`, `POST /files/{id}/reindex`.

---

## 3. Yaradılacaq fayllar
```
backend/crates/storage/
backend/crates/documents/
backend/crates/jobs/
backend/crates/api/src/routes/files.rs
backend/migrations/000X_files.sql (files, file_versions, file_extractions)
```

---

## 4. Qəbul meyarı
- Fayl yüklənir → S3-də obyekt, DB-də `storage_key` + `sha256` dedupe işləyir.
- `file_extractions.status` `pending → extracting → ready/failed` keçir.
- Ölçü/MIME/ClamAV yoxlamaları rədd edir (422/4xx).
