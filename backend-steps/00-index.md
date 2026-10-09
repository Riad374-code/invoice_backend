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
