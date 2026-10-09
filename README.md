# backend

See backend/README.md and BACKEND.md.

## Accounting RAG / OCR prototype

The standalone Python module is in [`modules/lexaudit_rag`](modules/lexaudit_rag).
See its [handoff guide](modules/lexaudit_rag/RAG_INTEGRATION.md) for the four tools,
setup and validation. It contains a prepared Azerbaijani Tax Code index; no private
receipts or API keys are included.

The module is wired into the TypeScript backend through an HTTP sidecar
(`modules/lexaudit_rag/service.py`, run with
`LEXAUDIT_SERVICE_TOKEN=... uvicorn service:app --port 8002`). Set
`RAG_OCR_BASE_URL` and `RAG_OCR_TOKEN` in the backend to enable it:

- scanned PDFs / images are OCR-ed through `POST /v1/ocr` (stateless, replaces the
  model-serving OCR; other model-serving features still use `MODEL_SERVING_BASE_URL`);
- agent tools `regulations.search`, `receipts.search`, `receipts.get`,
  `receipts.ingest` (company id always taken from the session, files by id not path).

The prototype uses 384-dimensional E5 vectors in its own store; the backend's pgvector
index stays separate (1,024 dims). Receipt records are never mapped to
`ExtractedInvoiceSchema` (buyer, number, net/VAT lines would have to be invented);
they remain `needs_review` evidence for the agent. The sidecar stores receipts on
local disk (single process) and must not be exposed publicly.
