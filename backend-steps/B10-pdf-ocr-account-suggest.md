# B10 — PDF/OCR çıxarışı + hesab kodu təklifi

> Mənbə: `BACKEND.md` §15 İnkişaf ardıcıllığı
> Orijinal sətir (dəyişdirilmədən):
> `| B10 | PDF/OCR çıxarışı + hesab kodu təklifi | |`
> Tam BACKEND.md: `../BACKEND.md`

---

## 1. Bu addıma aid orijinal tələblər (BACKEND.md-dən olduğu kimi)

### §3 Qovluq — aid hissə (olduğu kimi):
```
│   ├── documents/                # PDF/şəkil/XML/Excel parse, OCR çağırışı
```

### §4.2-dən aid (olduğu kimi):
| Cədvəl | Əsas sahələr |
|---|---|
| `invoice_lines` | description, qty, unit_price, vat_rate_code, net, vat, account_suggestion, account_final |

### §4.3-dən aid (olduğu kimi):
| Cədvəl | Əsas sahələr |
|---|---|
| `file_extractions` | text, layout_json, status (`pending/extracting/ready/failed`), error |

### §7 Sənəd emalı pipeline-ı — B10-a aid hissələr (olduğu kimi, tam mətn saxlanılır):
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

- B10 fokusu (mətni dəyişdirmədən): `PDF (mətnli) → mətn + layout çıxarışı → model: extract_invoice`, `PDF/şəkil (skan) → OCR (model-serving) → model: extract_invoice`, `model: suggest_accounts → invoice_lines.account_suggestion`, `extraction_confidence`, `< 0.85` qaydası.

### §10.2-dən aid alət (olduğu kimi):
| Alət | Risk | Qeyd |
|---|---|---|
| `mhbs.classify` | read | MHBS/MMUS təsnifatı təklifi |

### §13 Model xidməti — B10-a aid sətirlər (olduğu kimi):
| Endpoint | Məqsəd |
|---|---|
| `POST /v1/extract/invoice` | Qaimə çıxarışı (JSON schema-ya uyğun) |
| `POST /v1/ocr` | Skan sənədlər |
| `POST /v1/classify/account` | Hesab kodu təklifi |

Həmçinin (olduğu kimi):
> Hər AI nəticəsi ilə `model_version` saxlanılır (izlənə bilmə və rollback üçün).

### §4.1-dən aid (hesablar planı konteksti, olduğu kimi):
| Cədvəl | Əsas sahələr |
|---|---|
| `chart_of_accounts`, `accounts` | code (məs. 211, 221, 223, 241, 521, 531, 601), name_az/ru/en, type, parent_id |

---

## 2. Detallı görüləcək işlər

### 2.1 PDF mətnli
- [ ] Mətn + layout çıxarışı → `file_extractions.text, layout_json`, status `ready`.
- [ ] Sonra `model: extract_invoice` (`POST /v1/extract/invoice`, JSON schema-ya uyğun) → `invoices / invoice_lines (status = extracted, confidence)` — `extraction_confidence` saxla.

### 2.2 Skan (PDF/şəkil)
- [ ] OCR (`POST /v1/ocr` via model-serving) → `model: extract_invoice`.
- [ ] Xəta halında `file_extractions.status=failed, error` yaz.

### 2.3 Hesab kodu təklifi
- [ ] `model: suggest_accounts` / `POST /v1/classify/account` → `invoice_lines.account_suggestion` (təklif, final deyil — `account_final` insan/agent təsdiqi ilə).
- [ ] `mhbs.classify` (MHBS/MMUS təsnifatı təklifi, read risk).
- [ ] Hər AI nəticəsi ilə `model_version` saxla.

### 2.4 Confidence qaydası
- [ ] Aşağı confidence (məs. < 0.85) olan sahələr UI-da sarı işarələnir və insan yoxlaması tələb olunur (frontend-ə `extraction_confidence` + sahə səviyyəli confidence ötür).

---

## 3. Yaradılacaq fayllar
```
backend/crates/documents/src/pdf_extract.rs
backend/crates/documents/src/ocr_client.rs
backend/crates/documents/src/account_suggest.rs
backend/crates/api/src/routes/invoices.rs (artıq B6-da varsa genişləndir: propose-entries)
```

---

## 4. Qəbul meyarı
- Mətnli PDF və skan üçün çıxarış `file_extractions`-da `ready`, xəta `failed+error`.
- Qaimə JSON schema-ya uyğun çıxarılır, `account_suggestion` təklif kimi yazılır (`account_final` boş qalır).
- `< 0.85` confidence bayrağı ötürülür.
