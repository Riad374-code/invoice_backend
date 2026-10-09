# Current RAG + OCR module

For this repository: create a Python virtual environment inside this directory,
install `requirements.txt`, and copy `.env.example` to `.env` only when running
Gemini calls. Use `python -m unittest discover -s tests -v` for offline checks.
The model weights download on the first E5 retrieval. Python 3.14.3 was used
for the included validation. This module is not automatically called by the
TypeScript backend; see the root README for compatibility notes.

The accountant-assistant work now lives in `rag_tools.py`. See
[RAG_INTEGRATION.md](RAG_INTEGRATION.md) for the four agent tools, setup, changes,
validation results, and remaining limitations. The cleaned legal index is included.

The material below documents the earlier requirement-change API, which remains
available separately in `app.py`.

---

# LexAudit — two-hour delivery package

Final demo scope: supplied old/new requirement + short company procedures → changed
obligations → source-linked assessments and proposed edits → recorded human decision.

This is the AI backend for your full-stack team's app. It uses two Gemini calls on
changed inputs, keeps every supplied passage in the comparison, verifies exact
citations, and persists the analysis and append-only review events in SQLite.
No classifier, encoder training, vector database or external legal search is needed.

## Start on your Mac

Unzip the folder next to your existing project; existing artifacts are not needed.
Use a separate environment to avoid changing your working ML dependencies:

```bash
cd lexaudit_llm
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
export GEMINI_API_KEY='your-key-from-google-ai-studio'
export GEMINI_MODEL='gemini-3.8-flash'
python app.py
```

Get a key at https://aistudio.google.com/apikey. Keep it on the backend and out of
Git and the browser. The default model is the ID listed in Google's current API
documentation. Access and free quota are account-specific: if the model is unavailable,
set `GEMINI_MODEL` to an eligible text model shown in your AI Studio project.
Free-tier Google content may be used for product improvement; use the included
fictional documents or appropriate public text. There is no paid-provider fallback.

Open http://127.0.0.1:8001/docs for the interactive API.
`GET /health` checks local readiness only; it does not verify a live model call.

In a second terminal, activate the same environment and run:

```bash
python client.py examples/complaints_az.json --output reports/demo_az.json
python evaluate_live.py
```

The first command is the live integration gate. Check its response before polishing
the UI. There is no fabricated output or fixture mode in the running service.
`evaluate_live.py` runs five small authored development checks and records actual
responses. It is not an expert-reviewed or held-out accuracy benchmark. Some calls
reuse earlier successful analyses and are marked `cached`; do not present those
durations as fresh inference latency. A reviewer should inspect every demo finding.

## Fixed two-hour team plan

Timeboxes are budgets, not measured runtime guarantees. Start relative to now.

| Time | AI/backend owner | Full-stack teammates |
| --- | --- | --- |
| 0–15 minutes | Set key, start service, obtain one real Azerbaijani response | Start against the request JSON and `/docs`; old/new requirement fields and procedure inputs |
| 15–50 minutes | Run development smoke checks; inspect quotes and the acknowledgement/resolution distinction | Render changed obligation, source quote, status and proposed edit |
| 50–80 minutes | Resolve integration errors; confirm saved reviews survive restart | Wire approve/reject/needs-revision buttons and history display |
| 80–105 minutes | Review English/Azerbaijani outcomes and document failures honestly | Rehearse the entire flow with the team's accessible demo |
| 105–120 minutes | Freeze source, preserve real output/report and record model/version | Record the video; check source access, submission and demo link |

If a key or free quota blocks the first 15-minute gate, resolve API access before
adding features. Do not present a cached replay as a fresh live call.

## Stable integration contract

`POST /analyze-change` accepts:

```json
{
  "old_requirement": "Old supplied text",
  "new_requirement": "New supplied text",
  "language": "az",
  "effective_date": null,
  "scenario": "fictional",
  "documents": [
    {"document_id": "policy_a", "title": "Complaint procedure", "source_location": "Section 4.2", "text": "Procedure text"}
  ]
}
```

Use `az` or `en` for explanations. Quotes always remain in their source language.
Documents are text supplied by your frontend/backend; paragraphs separated by blank
lines become individually identified passages. Exact source character offsets refer
to the submitted document text, not to a PDF file. Bounds: 12 documents, 60,000 total
characters, 40 paragraphs, six extracted changes and 120 change/passage combinations.
Oversized input is rejected, never silently truncated.

Important response fields:

| Field | How the UI uses it |
| --- | --- |
| `analysis_id` | Read back the analysis and submit review actions |
| `changes` | Display the changed action, old/new rule and supporting quotes |
| `assessments` | One entry for every change/passage pair; filter `relevant=true` for the main cards |
| `assessments[].evidence` | Original document ID, quote, source location and character range |
| `assessments[].proposed_edit` | Draft replacement for the quoted passage; never auto-applied |
| `coverage` | A change with no relevant passage is `insufficient_evidence` |
| `counts` | Display category counts; zero conflicts does not mean compliance |
| `cached` | Mark a reused result visibly |
| `review_history` | Reviewer decisions with timestamps, source hash and optional edited proposal |

Assessment statuses: `potential_inconsistency`, `appears_aligned`,
`insufficient_evidence`, `irrelevant`. Aligned text is relevant. Missing text is
insufficient evidence, not an automatic violation. The endpoint verifies quote
existence, not semantic or legal correctness. No operational performance is inferred.

Save a review using `POST /analyses/{analysis_id}/review`:

```json
{
  "finding_id": "F1",
  "decision": "approved",
  "reviewer": "Eldəniz",
  "note": "Reviewed the supplied requirement and proposed wording.",
  "edited_proposal": null
}
```

Other decisions: `rejected`, `needs_revision`. Approval records a decision on the
draft; it does not rewrite the uploaded document. Reviewer names are supplied by
your UI, not verified user identities. Your main application's account/session
system should provide the name. This demo uses one shared backend access token,
not organization-specific access controls.

`GET /analyses/{analysis_id}` returns the saved analysis with its latest review
statuses and full review history. Data survives process restarts in
`runtime/lexaudit.sqlite3`; keep this file with the deployed backend. Repeat requests
with the same input/model/prompt version return the stored result and preserve reviews.
Changing document text produces a new analysis; it does not retroactively modify
the old analysis or import old approvals.

Example frontend fetch (best placed in your existing backend route):

```javascript
const response = await fetch(`${AI_BASE_URL}/analyze-change`, {
  method: "POST",
  headers: {"Content-Type": "application/json", "Authorization": `Bearer ${AI_TOKEN}`},
  body: JSON.stringify(payload)
});
const result = await response.json();
if (!response.ok) throw new Error(result.detail ?? "Analysis failed");
```

Display a loading state while the two calls run. Some requests take a minute or
longer. Do not keep clicking retry: a concurrent analysis returns 503. The service
retries transient provider statuses once; quota exhaustion returns a clear error.

| Status | Meaning |
| --- | --- |
| 401 | Missing/wrong configured backend bearer token |
| 422 | Invalid/oversized input or invalid review target |
| 502 | Provider problem or unverified/invalid model output; no findings accepted |
| 503 | Another analysis is running; retry shortly |

## Connect to the team's app

By default the service binds only to `127.0.0.1:8001`. For a controlled team network
or backend host, configure a strong token before binding externally:

```bash
export LEXAUDIT_API_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
export LEXAUDIT_HOST='0.0.0.0'
export LEXAUDIT_CORS_ORIGINS='http://localhost:3000,http://localhost:5173'
python app.py
```

The team's server should call this service and keep the bearer token server-side.
If the browser directly calls during local development, use an explicit development
origin; do not bake a permanent token into a public frontend. A deployed frontend
cannot access your laptop's `localhost`: your teammate must host the backend or
provide a reachable route. This zip does not deploy a public service. Use HTTPS
on the team's deployed endpoint. Port and DB path can be configured with
`LEXAUDIT_PORT` and `LEXAUDIT_DB`.

## Verification already completed

Run the offline tests yourself:

```bash
python -m unittest discover -s tests -v
```

The package was checked with 12 passing offline tests covering the API contract,
unknown/duplicate/omitted references, fabricated quotes, category consistency,
exact offsets, no-evidence behavior, unchanged text, configured authentication,
provider parsing, caching and append-only decisions across a database reopen.
Those tests use clearly labeled synthetic provider fixtures and do not establish
Gemini's performance. No live provider test was run when this package was authored:
your key, available model and quota must pass the live gate above.

## What to claim in the demo

Demonstrate the supplied fictional change from five to two business days:
procedure A needs review, procedure B appears aligned, and the 30-day resolution
passage is a different obligation. Show real citations, a draft edit, a saved human
decision and the source versions. Report observed failures and real live latency.

Disclose: pretrained Gemini; no custom model training in this serving path;
fictional inputs; small development checks; human review required. Your previous
classifier experiment remains a separate comparison and is not used by this service.

This package does not implement OCR/PDF parsing, regulatory monitoring, operational
business-day calculations, legal certification, email delivery or automatic edits.
The frontend supplies extracted text; keeping this boundary fixed protects the
two-hour integration window.

Provider references checked when building:
- https://ai.google.dev/gemini-api/docs/structured-output
- https://ai.google.dev/api/generate-content
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/rate-limits
