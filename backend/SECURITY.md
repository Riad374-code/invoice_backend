# Təhlükəsizlik yoxlaması və release checklist (B15)

## Release checklist

- [ ] `npm run typecheck && npm run lint && npm run format:check && npm test` yaşıldır
- [ ] `npm run openapi` — `openapi.json` dəyişməyib (CI yoxlayır)
- [ ] CI real Postgres + MinIO işi keçib (`real-services.test.ts`)
- [ ] Prod env: `DATABASE_URL`, `S3_*`, `CLAMAV_HOST`, ≥32 simvol `JWT_SECRET`/`CSRF_SECRET` (config bunlarsız başlamır)
- [ ] `AUTO_MIGRATE=false`; migrasiyalar ayrıca `npm run migrate` ilə tətbiq olunur
- [ ] `load/k6-smoke.js` staging-də işlədilib (p95 < 500ms, xəta < 1%)
- [ ] Platforma şirkəti (`companies.is_platform`) yalnız bir dənədir

## Mövcud nəzarətlər

argon2id, 15 dəq JWT, refresh rotation + reuse detection, CSRF, TOTP, route-level RBAC (elan edilməyən route → boot xətası), rate limit, Idempotency-Key, append-only audit, PII maskalama, SSRF-safe fetcher, antivirus, approvals (təsdiqləyən ≠ sorğu verən), imtiyaz yüksəltmə qarşısı (rol vermə yalnız öz icazələrinin alt çoxluğu).

## Məlum boşluqlar (açıq)

1. **RLS təsirsizdir**: siyasətlər var, amma tətbiq superuser/owner kimi qoşulur və `app.current_company_id` təyin etmir. Tətbiq səviyyəsində hər sorğuda `company_id` süzgəci var və testlərlə yoxlanıb. Düzəliş: non-owner DB rolu + hər tx-də `SET LOCAL app.current_company_id`.
2. Real model-serving, ClamAV və S3 yalnız CI-də/staging-də yoxlanılır; lokal testlər fake istifadə edir.
3. Yük testi skripti hazırdır, lakin bu mühitdə icra olunmayıb.
4. Docker/Rust olmadığından `docker-compose.yml` bu maşında işə salınmayıb.
