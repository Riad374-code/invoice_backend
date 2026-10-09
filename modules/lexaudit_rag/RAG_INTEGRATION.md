# LexAudit RAG + OCR handoff

This component supplies evidence to the main accounting agent. It does not post
expenses, decide tax eligibility, or contain the agent itself. `app.py` still
implements the earlier change-review demo; these tools are a separate Python interface.

## Agent integration

```python
from rag_tools import (
    search_regulations, search_documents, get_document, ingest_document,
)

# Backend context supplies this value, not the LLM or an arbitrary request field.
company_id = authenticated_company_id

# Upload handling calls this with a backend-controlled uploaded file path.
record = ingest_document(saved_upload_path, company_id)

candidates = search_documents(
    "Yanacaq qəbzi", company_id,
    date="2020-09-24", supplier="SOCAR", top_k=5,
)
if candidates:
    receipt = get_document(candidates[0]["document_id"], company_id)

sources = search_regulations("Hansı xərclər gəlirdən çıxıla bilər?", top_k=5)
```

Bind the authenticated company ID in the main backend's tool wrappers. A model
must not choose another company or an arbitrary server file path. This is a
local Python integration; your friend can import it into the agent backend or
expose authenticated routes from that backend. No network API was added here.

- `search_regulations` returns one primary passage per article. `related_passages`
  includes the article's first passage and immediate neighbors. Each has its own
  citation ID. Flatten and deduplicate those IDs before giving evidence to an LLM.
  `evidence_complete_article` says whether the supplied group covers the article.
- `search_documents` returns candidates, or `[]`. Optional `date` is YYYY-MM-DD;
  `supplier` applies lexical filtering. Scores are ranking signals, not confidence.
- `get_document` returns a record or `None`, scoped to the company. `fields` masks
  flagged values; `extracted_fields` preserves original OCR values. `validation`
  lists issues and `unsafe_fields`. Existing receipt files are checked on read and
  are not rewritten or uploaded again.
- `ingest_document` calls Gemini Vision, saves the original file, records extracted
  fields and structured `line_items`, and embeds the text. Repeating an existing
  file returns its existing record. `items` remains available for old callers.
- Every receipt remains `needs_review` and `accounting_ready=false`. An empty
  issue list is not proof of correctness. The main agent may prepare a draft;
  posting and human approval belong to the main application.

For structured line items, quantity, unit price, amount, and exact OCR-text quote
are requested. The quote check proves membership in the OCR transcript, not visual
accuracy against the image. No missing amounts or tax calculations are invented.

## Run and rebuild

Activate this project's environment, then:

```bash
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
python search_legal.py "Hansı xərclər gəlirdən çıxıla bilər?"
python receipt_rag.py search "Yanacaq qəbzi" --company demo_company
python answer_legal.py "ƏDV ödəyicisi kimlərdir?"
```

Only the last command and receipt ingestion need a Gemini key. Credentials remain
in the existing environment or `.env`; explicit environment values take priority.
The same lazily loaded E5 model is shared by legal and receipt retrieval.

The cleaned index is already included. To rebuild from the saved official HTML:

```bash
python scrape_tax_code.py --html data/laws/vergi_source.html
python build_legal_index.py
```

Omit `--html` only when intentionally fetching a new snapshot. Back up the existing
index first. The parser requires its expected amendment-history boundary and
minimum article coverage. Review unexpected source-format changes manually.
The index validates content hashes; do not mix old embeddings with new chunks.
Rebuild while readers are stopped; a partial update is rejected rather than served.
Chunk IDs may change between rebuilds, so retain the old snapshot for old answers.

## What changed

The scraper now reads HTML paragraph boundaries, preserves multiline article
titles and table rows, and removes struck-out text, footnote markers, and the
amendment-history appendix. Long paragraphs split using the actual tokenizer;
all complete embedding inputs, including titles and prefixes, are checked against
512 tokens. This replaces the old 180-word windows, which could silently truncate.

Retrieval combines E5 and BM25 ranks with a small Azerbaijani prefix-matching
heuristic. Explicit article references are prioritized and duplicate articles
are suppressed. Neighbor evidence reduces cut-off provisions, but lengthy
articles and cross-referenced exceptions may require further retrieval.

Receipt search requires both a minimum vector similarity (default 0.70) and lexical
support (at least 34% of meaningful query terms). These are conservative demo
heuristics, not calibrated relevance probabilities. They can reject valid synonyms;
ask for supplier/date or rephrase when no result is found. This is not a learned
relevance classifier or a guarantee that every returned candidate is relevant.

Validation catches placeholder receipt numbers, malformed dates/VÖENs, ambiguous
amount formats, subtotal/VAT/total disagreement, and line-item arithmetic issues.
Values are not silently corrected. Old free-text items remain available but are
flagged as unstructured. Historical transaction dates must not automatically be
interpreted using today's legislation.

## Validation and limits

`validation_report.json` records smoke checks against the saved legal index and
existing SOCAR receipt. These are development checks, not an expert-reviewed
benchmark. Unit tests additionally exercise unrelated-document rejection, company
isolation, input validation, parser cleanup, chunk boundaries and receipt checks.
No fresh Gemini answer or new-image OCR call was made for this update.

The corpus still covers only the Tax Code. Its downloaded snapshot, article
completeness and each provision's effective dates have not been legally certified.
`validity_verified=false` is propagated to callers. A local rebuild does not claim
a new source retrieval date. Historical legal versioning is not implemented.
Citations are verified for source membership, not legal support for every claim.

Storage is intended for a local single-process demo. Concurrent ingestion across
multiple workers and production authorization/storage policies need a backend
implementation before deployment. Keep receipt data and backups out of Git.
