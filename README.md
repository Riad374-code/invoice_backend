# backend

See backend/README.md and BACKEND.md.

## Accounting RAG / OCR prototype

The standalone Python module is in [`modules/lexaudit_rag`](modules/lexaudit_rag).
See its [handoff guide](modules/lexaudit_rag/RAG_INTEGRATION.md) for the four tools,
setup and validation. It contains a prepared Azerbaijani Tax Code index; no private
receipts or API keys are included.

This contribution does not wire the module into the TypeScript backend yet.
The prototype uses 384-dimensional multilingual-E5-small vectors; the backend
expects 1,024-dimensional vectors (`backend/src/rag/clients.ts`). Keep the stores
separate or rebuild embeddings with a consistent model before importing vectors.
The Python receipt schema also differs from `ExtractedInvoiceSchema`: do not
invent missing buyer, invoice number, net/VAT fields or confidence scores to satisfy
that contract. The main backend must authenticate company scope, map reviewed
fields, and own draft creation/approval.
