# B6 — Invoices: XML parse, validasiya, issues

> Mənbə: `BACKEND.md` §15 İnkişaf ardıcıllığı
> Orijinal sətir (dəyişdirilmədən):
> `| B6 | Invoices: XML parse, validasiya, issues | |`
> Tam BACKEND.md: `../BACKEND.md`

---

## 1. Bu addıma aid orijinal tələblər (BACKEND.md-dən olduğu kimi)

### §2 Texnologiya — aid sətirlər (olduğu kimi):
| Sahə | Seçim |
|---|---|
| XML (e-qaimə, 1C export) | **quick-xml** |
| 1C inteqrasiyası | Excel/XML export-import parser-ləri (versiyalı şablonlar) |
| Pul | **rust_decimal** — `f64` qadağandır |

### §3 Qovluq — aid hissə (olduğu kimi):
```
│   ├── documents/                # PDF/şəkil/XML/Excel parse, OCR çağırışı
```

### §4.2 Mühasibat — B6-ya aid cədvəllər (olduğu kimi, tam köçürülüb):
| Cədvəl | Əsas sahələr |
|---|---|
| `counterparties` | name, voen, country, is_vat_payer |
| `invoices` | direction (sales/purchase), number, issue_date, counterparty_id, currency, net, vat, gross, status (enum), source_file_id, extraction_confidence |
| `invoice_lines` | description, qty, unit_price, vat_rate_code, net, vat, account_suggestion, account_final |
| `invoice_issues` | invoice_id, code (`VAT_RATE_MISMATCH`, `TOTAL_MISMATCH`, `INVALID_TAX_ID`…), severity, detail |
| `import_jobs` | source (`1c`/`etaxes`/`bank`), template_version, file_id, rows_ok, rows_failed, status |

İndeks (olduğu kimi):
> İndekslər: `chunks` üzərində HNSW (`vector_cosine_ops`) + GIN (`tsv`); `invoices(company_id, issue_date)`; `news_items(canonical_url)` unique; `audit_events(company_id, created_at)`.
- B6 üçün: `invoices(company_id, issue_date)`.

### §5 API — Invoices qrupu (olduğu kimi):
| Qrup | Endpoint-lər (nümunə) |
|---|---|
| Invoices | `POST /invoices/upload`, `GET /invoices`, `GET /invoices/{id}`, `PATCH /invoices/{id}`, `POST /invoices/{id}/validate`, `POST /invoices/{id}/propose-entries` |

### §6.2-dən aid funksiya (olduğu kimi):
```
invoice::check(invoice) -> Vec<InvoiceIssue>       // cəm, dərəcə, tarix, VÖEN, dublikat
```

### §6.1-dən aid prinsip (olduğu kimi):
- Hər nəticə `explanation` qaytarır: hansı dərəcə, hansı qanun mənbəyi, hansı addımlar.

### §7 Sənəd emalı pipeline-ı — B6-ya aid hissə (olduğu kimi, tam saxlanılır):
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
- B6-da fokus: e-qaimə (e-taxes.gov.az export: Excel/XML) → şablon parser → birbaşa parse (AI yoxdur, 100% dəqiq) + 1C export → şablon parser → `import_jobs` + `accounting::invoice::check → invoice_issues`.

### §10.2 Alətlər — B6-ya aid (olduğu kimi):
| Alət | Risk | Qeyd |
|---|---|---|
| `invoice.get`, `invoice.list`, `invoice.validate` | read | |

### §11-dən aid (olduğu kimi):
| Qayda | Audit |
|---|---|
| Status = Rust enum + state machine; etibarsız keçid → `409 CONFLICT` | A-04 |
| Tapılmayan resurs → `404`; fallback yoxdur | A-05 |

---

## 2. Detallı görüləcək işlər

### 2.1 Parserlər
- [ ] `quick-xml` ilə e-qaimə (e-taxes.gov.az export: Excel/XML) şablon parser → birbaşa parse, AI yoxdur, 100% dəqiq.
- [ ] 1C export (Excel/XML) → versiyalı şablon parser-lər → `import_jobs` (`source=1c/etaxes/bank`, `template_version`, `file_id`, `rows_ok`, `rows_failed`, `status`).
- [ ] `counterparties` — `name, voen, country, is_vat_payer`.

### 2.2 Invoices DB
- [ ] `invoices` — `direction (sales/purchase), number, issue_date, counterparty_id, currency, net, vat, gross, status (enum), source_file_id, extraction_confidence`.
- [ ] `invoice_lines` — `description, qty, unit_price, vat_rate_code, net, vat, account_suggestion, account_final`.
- [ ] `invoice_issues` — `invoice_id, code (VAT_RATE_MISMATCH, TOTAL_MISMATCH, INVALID_TAX_ID…), severity, detail`.
- [ ] `accounting::invoice::check` → `invoice_issues` (cəm, dərəcə, tarix, VÖEN, dublikat).
- [ ] Pul `string` kimi API-də, DB-də NUMERIC, kodda `Decimal`.

### 2.3 API
- [ ] `POST /invoices/upload`, `GET /invoices`, `GET /invoices/{id}`, `PATCH /invoices/{id}`, `POST /invoices/{id}/validate`, `POST /invoices/{id}/propose-entries`.
- [ ] Status Rust enum + state machine; etibarsız keçid → `409 CONFLICT`; tapılmayan → `404`, fallback yoxdur.

---

## 3. Yaradılacaq fayllar
```
backend/crates/documents/src/etaxes_parser.rs (şablon parser)
backend/crates/documents/src/onec_parser.rs (versiyalı şablonlar)
backend/crates/api/src/routes/invoices.rs
backend/migrations/000X_invoices.sql
```

---

## 4. Qəbul meyarı
- e-qaimə XML-i AI-sız 100% dəqiq parse olunur.
- `invoice::check` cəm/dərəcə/tarix/VÖEN/dublikat xətalarını `invoice_issues`-da yaradır.
- İndeks `invoices(company_id, issue_date)` mövcuddur.
