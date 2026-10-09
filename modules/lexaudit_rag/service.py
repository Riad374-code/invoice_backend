"""HTTP sidecar exposing the RAG/OCR tools to the TypeScript backend.

Only the backend calls this service (bearer token). company_id is supplied by the
backend from the authenticated session, never by an LLM or an end user. Files are
sent as bytes; no server paths are accepted.

    LEXAUDIT_SERVICE_TOKEN=... uvicorn service:app --host 127.0.0.1 --port 8002
"""
import hmac
import mimetypes
import os
import re
import tempfile
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field

load_dotenv(Path(__file__).resolve().parent / ".env", override=False)

import rag_tools  # noqa: E402
from receipt_rag import SUPPORTED, extract_receipt_fields  # noqa: E402

TOKEN = os.getenv("LEXAUDIT_SERVICE_TOKEN", "")
MAX_BYTES = 15 * 1024 * 1024
COMPANY_RE = r"^[A-Za-z0-9_-]{1,64}$"

app = FastAPI(title="LexAudit RAG/OCR sidecar", version="1.0")


def auth(authorization: str = Header(default="")):
    if not TOKEN:
        raise HTTPException(503, "LEXAUDIT_SERVICE_TOKEN is not configured")
    supplied = authorization.removeprefix("Bearer ").strip()
    if not hmac.compare_digest(supplied, TOKEN):
        raise HTTPException(401, "Unauthorized")


def guarded(fn):
    try:
        return fn()
    except HTTPException:
        raise
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(422, str(e))
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    except Exception as e:  # provider / model failures must not leak as 500 stack traces
        raise HTTPException(502, f"{type(e).__name__}: {e}")


class RegSearch(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    topK: int = Field(default=5, ge=1, le=20)


class DocSearch(BaseModel):
    companyId: str = Field(pattern=COMPANY_RE)
    query: str = Field(min_length=1, max_length=4000)
    topK: int = Field(default=5, ge=1, le=20)
    date: Optional[str] = None
    supplier: Optional[str] = None


@app.get("/health")
def health():
    return {"ok": True, "gemini": bool(os.getenv("GEMINI_API_KEY"))}


@app.post("/v1/regulations/search", dependencies=[Depends(auth)])
def regulations(body: RegSearch):
    return {"results": guarded(lambda: rag_tools.search_regulations(body.question, body.topK))}


@app.post("/v1/documents/search", dependencies=[Depends(auth)])
def documents(body: DocSearch):
    return {
        "results": guarded(
            lambda: rag_tools.search_documents(
                body.query, body.companyId, body.topK, body.date, body.supplier
            )
        )
    }


@app.get("/v1/documents/{document_id}", dependencies=[Depends(auth)])
def document(document_id: str, companyId: str):
    if not re.match(COMPANY_RE, companyId):
        raise HTTPException(422, "Invalid companyId")
    record = guarded(lambda: rag_tools.get_document(document_id, companyId))
    if record is None:
        raise HTTPException(404, "Document not found")
    return record


async def _read_upload(file: UploadFile) -> tuple[bytes, str, str]:
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "File exceeds 15 MB")
    suffix = (Path(file.filename or "").suffix or mimetypes.guess_extension(file.content_type or "") or "").lower()
    if suffix not in SUPPORTED:
        raise HTTPException(422, "Unsupported document format")
    mime = mimetypes.guess_type("x" + suffix)[0] or file.content_type or ""
    return data, suffix, mime


@app.post("/v1/documents/ingest", dependencies=[Depends(auth)])
async def ingest(companyId: str = Form(pattern=COMPANY_RE), file: UploadFile = File(...)):
    data, suffix, _ = await _read_upload(file)
    # The upload lands in a private temp file; the module copies it into its own store.
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / ("upload" + suffix)
        path.write_bytes(data)
        return guarded(lambda: rag_tools.ingest_document(str(path), companyId))


@app.post("/v1/ocr", dependencies=[Depends(auth)])
async def ocr(file: UploadFile = File(...)):
    """Stateless OCR: returns the extracted fields, stores and indexes nothing."""
    data, _, mime = await _read_upload(file)
    fields = guarded(lambda: extract_receipt_fields(data, mime))
    return {"text": fields["raw_text"], "fields": fields, "model": os.getenv("GEMINI_MODEL", "gemini-2.5-flash")}
