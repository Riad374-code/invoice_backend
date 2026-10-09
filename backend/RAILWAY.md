# Railway deploy

Services: **backend** (this folder, `Dockerfile` + `railway.json`), **Postgres with pgvector**, **object storage**, and
the **frontend** (nginx image from the frontend repo). Optional: RAG/OCR sidecar, model-serving.

## 1. Postgres

Add the _pgvector_ Postgres template (plain Railway Postgres has no `vector` extension; migration 0001 needs
`vector`, `pg_trgm`, `unaccent`, `btree_gist`, `pgcrypto`, `uuid-ossp`; the DB user must be allowed to `CREATE EXTENSION`).
Reference its URL from the backend: `DATABASE_URL=${{Postgres.DATABASE_URL}}` (use the private/internal URL).

## 2. Object storage

Production refuses to start without S3. Add a Railway Bucket (or Cloudflare R2 / MinIO) and set
`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` (path-style is used when `S3_ENDPOINT` is set).

## 3. Backend variables

| Variable                                          | Value                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                                         | `production`                                                                                                   |
| `JWT_SECRET`, `CSRF_SECRET`                       | two different random strings, >= 32 chars (`openssl rand -base64 48`)                                          |
| `DATABASE_URL`                                    | from step 1                                                                                                    |
| `AUTO_MIGRATE`                                    | `true` (migrations take an advisory lock, safe with several replicas; prod default is off)                     |
| `CORS_ALLOWED_ORIGINS`                            | the **frontend's public origin**, e.g. `https://lexaudit.up.railway.app` (no trailing slash)                   |
| `S3_*`                                            | from step 2                                                                                                    |
| `CLAMAV_DISABLED`                                 | `true` unless you run ClamAV (`CLAMAV_HOST`); a warning is logged when disabled                                |
| `SEED_DEMO_DATA`, `DEMO_PASSWORD`                 | optional demo company; password >= 12 chars. First demo company becomes the platform operator when none exists |
| `RAG_OCR_BASE_URL`, `RAG_OCR_TOKEN`               | optional sidecar (`modules/lexaudit_rag/service.py`)                                                           |
| `MODEL_SERVING_BASE_URL`, `MODEL_SERVING_API_KEY` | optional LLM/embeddings/rerank service                                                                         |

`PORT` is injected by Railway and used automatically (override with `BIND_ADDR`); `TRUST_PROXY` defaults to `true`
when `RAILWAY_ENVIRONMENT` is present. Health check: `/admin/health` (DB + storage). Jobs and cron run in the same process.

## 4. Frontend <-> backend

The frontend must see **one origin**: the frontend nginx serves the static build and proxies `/api/` to the backend.
The refresh cookie is `HttpOnly; Secure; SameSite=Strict` on `/api/v1/auth`, so the browser must talk only to the frontend host.
Frontend service variables: `BACKEND_URL=http://<backend-service>.railway.internal:<PORT>` and `DNS_RESOLVER` set to Railway's
private-network resolver (IPv6; check Railway docs for the current address). The backend's `PORT` must match `BACKEND_URL`
(set `PORT=8080` explicitly on the backend). If you cannot proxy, the cross-site setup will NOT work with `SameSite=Strict`.

## 5. After first deploy

1. `GET https://<frontend>/api/v1/admin/health` -> `status: ok`.
2. Log in as `admin@demo.lexaudit.local` (if seeded) or create the first company/admin by seed, then enter real tax rates in
   the admin console (sample 18%/0%/exempt rates have no legal source).
3. Mark exactly one company as platform operator (`companies.is_platform`) if the demo seed was not used.
