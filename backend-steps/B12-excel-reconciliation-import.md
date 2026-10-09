# B12 — Excel jobs + reconciliation + 1C / e-taxes / bank import

> Mənbə: `BACKEND.md` §15 İnkişaf ardıcıllığı
> Orijinal sətir (dəyişdirilmədən):
> `| B12 | Excel jobs + reconciliation + 1C / e-taxes / bank import | |`
> Tam BACKEND.md: `../BACKEND.md`

---

## 1. Bu addıma aid orijinal tələblər (BACKEND.md-dən olduğu kimi)

### §2 Texnologiya — aid sətirlər (olduğu kimi, tam):
| Sahə | Seçim |
|---|---|
| Excel | **calamine** (oxumaq), **rust_xlsxwriter** (yazmaq) |
| XML (e-qaimə, 1C export) | **quick-xml** |
| 1C inteqrasiyası | Excel/XML export-import parser-ləri (versiyalı şablonlar) |

### §3 Qovluq — aid hissə (olduğu kimi):
```
│   │       └── routes/           # auth, invoices, vat, ledger, excel, recon, news,
```

### §4.2-dən aid cədvəllər (olduğu kimi, tam):
| Cədvəl | Əsas sahələr |
|---|---|
| `import_jobs` | source (`1c`/`etaxes`/`bank`), template_version, file_id, rows_ok, rows_failed, status |
| `reconciliations`, `reconciliation_matches` | left_source, right_source, match_type, confidence, status |
| `excel_jobs` | input_file_id, operation, params, output_file_id, status |

### §5 API — Excel + Reconciliation (olduğu kimi):
| Qrup | Endpoint-lər (nümunə) |
|---|---|
| Excel | `POST /excel/jobs` (`profile`/`clean`/`reconcile`/`report`), `GET /excel/jobs/{id}` |
| Reconciliation | `POST /reconciliations`, `GET /reconciliations/{id}`, `POST /reconciliations/{id}/matches/{m}/confirm` |

### §10.2 Alətlər — B12-yə aid (olduğu kimi):
| Alət | Risk | Qeyd |
|---|---|---|
| `import.preview` (1C / e-taxes / bank) | read | İmport önbaxışı |
| `import.commit` | moderate-write | Təsdiq məcburi |
| `onec.export_entries` | low-write | 1C üçün fayl yaradır |
| `excel.profile`, `excel.query` | read | |
| `excel.generate_report` | low-write | Yeni fayl, orijinal dəyişmir |
| `reconcile.run` | low-write | Nəticə təklif kimi |

### §7-dən aid sətirlər (olduğu kimi):
- 1C export (Excel/XML) → şablon parser → import_jobs
- XLSX/CSV → calamine → profil

---

## 2. Detallı görüləcək işlər

### 2.1 Excel jobs
- [ ] `excel_jobs` — `input_file_id, operation, params, output_file_id, status`.
- [ ] `POST /excel/jobs` (`profile`/`clean`/`reconcile`/`report`), `GET /excel/jobs/{id}`.
- [ ] `calamine` oxumaq, `rust_xlsxwriter` yazmaq. `excel.profile`, `excel.query` (read); `excel.generate_report` (low-write — yeni fayl, orijinal dəyişmir).
- [ ] `XLSX/CSV → calamine → profil` (§7-dəki kimi).

### 2.2 Reconciliation
- [ ] `reconciliations, reconciliation_matches` — `left_source, right_source, match_type, confidence, status`.
- [ ] `POST /reconciliations`, `GET /reconciliations/{id}`, `POST /reconciliations/{id}/matches/{m}/confirm`.
- [ ] `reconcile.run` (low-write — nəticə təklif kimi).

### 2.3 Import (1C / e-taxes / bank)
- [ ] `import_jobs` — `source (1c/etaxes/bank), template_version, file_id, rows_ok, rows_failed, status`.
- [ ] Excel/XML export-import parser-ləri (versiyalı şablonlar) — `quick-xml` + `calamine`.
- [ ] `import.preview` (read — import önbaxışı) → `import.commit` (moderate-write — təsdiq məcburi).
- [ ] `onec.export_entries` (low-write — 1C üçün fayl yaradır).

---

## 3. Yaradılacaq fayllar
```
backend/crates/api/src/routes/excel.rs
backend/crates/api/src/routes/recon.rs (reconciliations)
backend/crates/documents/src/excel_profile.rs (calamine)
backend/crates/documents/src/import_templates.rs (versiyalı şablonlar)
backend/migrations/000X_excel_recon_import.sql
```

---

## 4. Qəbul meyarı
- Excel `profile/clean/reconcile/report` job-ları `output_file_id` ilə nəticələnir, orijinal dəyişmir.
- Import önbaxış → təsdiq → commit axını, `rows_ok/rows_failed` hesabatı.
- Recon match `confirm` ilə təsdiqlənir.
