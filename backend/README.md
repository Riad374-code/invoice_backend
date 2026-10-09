# LexAudit AI — backend

TypeScript · Node.js 24 · Fastify 5 · PostgreSQL 16 (+pgvector, pg_trgm, unaccent) · zod · vitest.
Spec: [`../BACKEND.md`](../BACKEND.md). Step plan and status: [`../backend-steps/00-index.md`](../backend-steps/00-index.md).

## Run without Docker (development)

```bash
cp .env.example .env        # set JWT_SECRET / CSRF_SECRET (>= 32 chars, different) ; clear DATABASE_URL
npm ci
npm run dev                 # in-memory Postgres (PGlite) + in-memory object storage; data is lost on exit
```

Optional first user: set `DEV_ADMIN_EMAIL` and `DEV_ADMIN_PASSWORD` in `.env`.
Health: `GET http://localhost:8080/admin/health` · OpenAPI: `GET /api/v1/openapi.json` (non-production).

## Run with Docker

```bash
JWT_SECRET=... CSRF_SECRET=... docker compose up --build      # api + postgres + minio (+ model-serving stub)
docker compose --profile av up                                  # also ClamAV (CLAMAV_HOST=clamav)
```

## Quality gates (CI)

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
npm run openapi            # regenerates openapi.json (CI fails if it is out of date)
```

`npm test` runs unit + integration tests against a **real Postgres engine in-process** (PGlite, with pgvector).
`tests/integration/real-services.test.ts` additionally runs in CI against PostgreSQL 16 and MinIO
(`TEST_DATABASE_URL`, `TEST_S3_ENDPOINT`).

## Layout

`src/domain` pure types and state machines · `src/db` Db adapters, migrations runner, repositories ·
`src/plugins` auth/rate-limit/idempotency/audit-guard/metrics · `src/routes` HTTP · `src/jobs` Postgres queue + cron ·
`src/storage` S3 · `src/documents` type detection/extraction · `src/audit` immutable log + PII masking.
Every route must declare `config.public`, `config.authOnly` or `config.permission` — otherwise the server refuses to boot.

## Demo / nümunə məlumat (deploy)

`SEED_DEMO_DATA=true` və `DEMO_PASSWORD` (≥12 simvol) təyin edilərsə, açılışda ayrı **"Demo MMC"** şirkəti
(VÖEN `0000000001`) yaranır: `admin|accountant|approver|viewer@demo.lexaudit.local`, hesab planı,
4 uydurma qarşı tərəf, 6 nümunə qaimə və təklif olunan jurnal yazılışları (heç biri post olunmayıb).
İdempotentdir, real şirkətlərin qeydiyyatını/məlumat daxiletməsini məhdudlaşdırmır. Dərəcələr cədvəli
boşdursa 18% / 0% / azad nümunə ƏDV dərəcələri də əlavə olunur (hüquqi mənbəsiz — real dərəcələri
admin konsolundan daxil edin). Demo məlumatı silmək üçün demo şirkət silinir.
