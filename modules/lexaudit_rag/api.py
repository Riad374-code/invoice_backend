import os
import re
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from answer_legal import answer_question
from rag_tools import search_documents, get_document
from receipt_rag import ingest_receipt

app = FastAPI(title="LexAudit API", version="1.0")

origins = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
]
origins += [
    origin.strip()
    for origin in os.getenv("FRONTEND_ORIGINS", "").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    question: str

def validate_company_id(company_id):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", company_id):
        raise HTTPException(400, "Invalid company_id")
    return company_id

@app.get("/health")
def health():
    return {"status": "ok", "service": "LexAudit"}

@app.post("/api/chat")
@app.post("/api/ask")
def chat(request: ChatRequest):
    try:
        answer = answer_question(request.question)
        return {"answer": answer}
    except Exception as exc:
        print("Chat error:", repr(exc))
        raise HTTPException(500, "Answer generation failed")

@app.get("/api/documents/search")
def document_search(query: str, company_id: str = "demo_company"):
    company_id = validate_company_id(company_id)
    results = search_documents(query, company_id)
    return {"results": jsonable_encoder(results)}

@app.get("/api/documents/{document_id}")
def document_get(document_id: str, company_id: str = "demo_company"):
    company_id = validate_company_id(company_id)
    result = get_document(document_id, company_id)
    if result is None:
        raise HTTPException(404, "Document not found")
    return jsonable_encoder(result)

@app.post("/api/receipts/upload")
async def receipt_upload(
    file: UploadFile = File(...),
    company_id: str = Form("demo_company"),
):
    company_id = validate_company_id(company_id)

    extension = Path(file.filename or "").suffix.lower()
    if extension not in {".jpg", ".jpeg", ".png", ".webp", ".pdf"}:
        raise HTTPException(400, "Unsupported file format")

    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "File too large")

    try:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / f"receipt{extension}"
            path.write_bytes(content)

            result = await run_in_threadpool(
                ingest_receipt, str(path), company_id
            )

        return {"result": jsonable_encoder(result)}

    except Exception as exc:
        print("OCR error:", repr(exc))
        raise HTTPException(500, "Receipt processing failed")
