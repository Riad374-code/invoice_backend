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

## 3. AI service connections

The quick demo, the RAG/OCR sidecar, and the full backend's model server have different APIs.
Setting `MODEL_SERVING_BASE_URL` to the working quick demo does not connect them.

| Service | Start / configuration | Provides |
|---|---|---|
| Quick demo API | `uvicorn api:app --port 8000` in `modules/lexaudit_rag/` | `/api/chat`, `/api/ask`, `/api/receipts/upload`, `/api/documents/search`; used by `quick_frontend/` |
| Backend RAG/OCR sidecar | `uvicorn service:app --port 8002`; backend `RAG_OCR_BASE_URL` + `RAG_OCR_TOKEN` | Authenticated Tax Code search, receipt ingestion/search and OCR |
| Full model server | Separate service, **not implemented in this repo**; backend `MODEL_SERVING_BASE_URL` + optional `MODEL_SERVING_API_KEY` | Assistant chat with tools, invoice extraction, account/news classification, embeddings and reranking |

### Connect the existing RAG/OCR sidecar

```bash
cd modules/lexaudit_rag && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Set GEMINI_API_KEY and a random LEXAUDIT_SERVICE_TOKEN in this .env.
uvicorn service:app --host 127.0.0.1 --port 8002
```

In `backend/.env`, set these **together**, then restart the backend:

```dotenv
RAG_OCR_BASE_URL=http://127.0.0.1:8002
RAG_OCR_TOKEN=<same value as LEXAUDIT_SERVICE_TOKEN>
MODEL_SERVING_BASE_URL=
```

Keep `MODEL_SERVING_BASE_URL` empty unless you also have a compatible model server.
The backend now rejects a URL without a token (or a token without a URL), instead of silently
disabling the sidecar. `GEMINI_API_KEY` belongs in the Python service's environment; it is not a URL
and it is not the shared service token. Both Python apps may run at once on different ports.

The sidecar supports OCR for uploaded scans and exposes Tax Code/receipt tools to the backend.
It **does not** implement the full assistant's language model, structured invoice import,
account suggestions, or news classification. Those still require the model server below.
For the already-working standalone legal chat and receipt demo, run `api:app` with `quick_frontend/`.

### Connect a full model server, if available

`MODEL_SERVING_BASE_URL` must be an HTTP(S) origin (for example `http://model-server:8001`),
without `/v1` or an API path. The client adds these paths:

- `POST /v1/chat/completions` — chat, tool calls and optional streaming
- `POST /v1/embeddings` and `POST /v1/rerank` — internal semantic search
- `POST /v1/extract/invoice`, `/v1/classify/account`, `/v1/classify/news` — structured model results
- `GET /v1/models` — model listing
- `POST /v1/ocr` — JSON/base64 OCR when the RAG/OCR sidecar is not configured

The structured contracts are defined in `backend/src/models/client.ts` and the retrieval contracts
in `backend/src/rag/clients.ts`. A generic chat API alone does not implement all of them.
When both services are configured, OCR goes to the sidecar and the other model calls stay on
the model server. The sidecar's `/v1/ocr` uses multipart upload, so it is not a drop-in replacement
for the model server's JSON endpoint.

The Docker `model-serving` service is only an HTTP echo placeholder. It is disabled by default
and can be started with `--profile model-stub` for connectivity tests; never use it for inference.
Docker now forwards the configured `MODEL_SERVING_BASE_URL` and `MODEL_SERVING_API_KEY`.

### Check the connection

`GET http://127.0.0.1:8002/health` identifies the sidecar and reports whether a Gemini key is set.
It does not verify the key or warm up the retrieval model. A real authenticated search tests the
token and legal index (the first call may download the E5 model):

```bash
curl --fail-with-body http://127.0.0.1:8002/v1/regulations/search \
  -H "Authorization: Bearer $LEXAUDIT_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"question":"ƏDV", "topK":1}'
```

Export `LEXAUDIT_SERVICE_TOKEN` in the shell before that check; the Python `.env` is not
automatically loaded into your shell. Never commit the token or a real API key.

If the backend is in Docker and the sidecar is on the host, `127.0.0.1` points inside the backend
container. On Docker Desktop use `host.docker.internal` and bind the sidecar to a reachable interface.
On Railway use the sidecar's reachable internal hostname and port; run it with `--host 0.0.0.0`.
The backend's `/admin/health` checks only its database and storage, not AI availability.

### Troubleshooting `MODEL_SERVING_BASE_URL`

- At startup, a warning means the optional full model server is disabled; the core backend still runs.
- During invoice import or classification with only the sidecar configured, the model service is
  genuinely missing. OCR alone does not turn the scan into the backend's invoice schema.
- With **both** services configured, older code lost model-client methods when installing the OCR
  adapter and falsely reported a missing URL. The adapter now forwards those methods explicitly.
- `401` from the sidecar means the shared tokens do not match; `404` commonly means the wrong
  Python app or endpoint. Connection refused means the configured service is not reachable.

## 4. Frontend
Separate folder. Point it at the backend: API base `http://localhost:8080/api/v1`; add the frontend origin to
`CORS_ALLOWED_ORIGINS` in `backend/.env` (default `http://localhost:3000`). Log in with the demo admin above.

## 5. Tests
`cd backend && npm test` (unit/integration tests with PGlite; 4 external PostgreSQL/MinIO tests run when their service URLs are supplied in CI).

## Known limitations
- Row-level security policies exist but are not yet enforced at DB level; tenant isolation is enforced in the app
  (every query is scoped by `company_id`, covered by tests). See `backend/SECURITY.md`.
- Sample VAT rates have no legal-source link; real rates must be entered via the admin console.
- RAG/OCR sidecar stores receipts on local disk (single process); Gemini OCR output is always `needs_review`.
- Load test script (`backend/load/k6-smoke.js`) was written but not run; sidecar and Docker flow not run end-to-end here.
- The legal index covers only the Tax Code and its effective dates are not legally certified.
