# Setup instructions (for judges)

Repo layout: `backend/` (TypeScript/Fastify API, this repo), `modules/lexaudit_rag/` (Python RAG + OCR sidecar),
frontend lives in its **own separate folder/repo** and talks to the backend over HTTP.

## 1. Backend (no Docker needed)
```bash
cd backend && npm ci
cp .env.example .env     # set JWT_SECRET and CSRF_SECRET (two different random strings, >= 32 chars)
# in .env also set:  SEED_DEMO_DATA=true   DEMO_PASSWORD=Demo-Passw0rd-2026
npm run dev              # http://localhost:8080 — in-process Postgres (PGlite), migrations + seed run on start
```
Docs: `http://localhost:8080/docs` (OpenAPI), health: `/admin/health`.
With Docker instead: `docker compose up` (Postgres+pgvector, MinIO; demo seed is on by default).

## 2. Credentials (demo company "Demo MMC", seeded by `SEED_DEMO_DATA=true`)
| Role | Email | Password |
|---|---|---|
| admin | `admin@demo.lexaudit.local` | value of `DEMO_PASSWORD` (compose default `Demo-Passw0rd-2026`) |
| accountant / approver / viewer | `accountant@` / `approver@` / `viewer@` `demo.lexaudit.local` | same |

Seed = fake data only: 6 sample invoices, chart of accounts, sample VAT rates (18% / 0% / exempt). Real companies
and real data can be created normally alongside it. Re-running is safe (idempotent).
Seed command is automatic on startup; set `SEED_DEMO_DATA=false` to disable.

## 3. Optional: RAG + OCR sidecar (Tax Code search, receipt OCR)
```bash
cd modules/lexaudit_rag && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
GEMINI_API_KEY=... LEXAUDIT_SERVICE_TOKEN=<secret> uvicorn service:app --port 8002
```
Then in `backend/.env`: `RAG_OCR_BASE_URL=http://127.0.0.1:8002` and `RAG_OCR_TOKEN=<same secret>`.
Without it the app runs; OCR/Tax-Code tools just report "not configured".

## 4. Frontend
Separate folder. Point it at the backend: API base `http://localhost:8080/api/v1`; add the frontend origin to
`CORS_ALLOWED_ORIGINS` in `backend/.env` (default `http://localhost:3000`). Log in with the demo admin above.

## 5. Tests
`cd backend && npm test` (≈470 tests, no external services; 4 real-Postgres/MinIO tests run in CI only).

## Known limitations
- Row-level security policies exist but are not yet enforced at DB level; tenant isolation is enforced in the app
  (every query is scoped by `company_id`, covered by tests). See `backend/SECURITY.md`.
- Sample VAT rates have no legal-source link; real rates must be entered via the admin console.
- RAG/OCR sidecar stores receipts on local disk (single process); Gemini OCR output is always `needs_review`.
- Load test script (`backend/load/k6-smoke.js`) was written but not run; sidecar and Docker flow not run end-to-end here.
- The legal index covers only the Tax Code and its effective dates are not legally certified.
