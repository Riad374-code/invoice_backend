from search_legal import LegalRetriever
import json
import uuid
import threading

from receipt_rag import search_receipts, company_folder, ingest_receipt
from receipt_validation import reviewed_record

# Initialize once instead of loading E5 for every request.
_retriever = None
_retriever_lock = threading.Lock()
_ingest_lock = threading.Lock()


def get_retriever():
    global _retriever

    with _retriever_lock:
        if _retriever is None:
            _retriever = LegalRetriever()
        return _retriever


def search_regulations(
    question: str,
    top_k: int = 8,
) -> list[dict]:
    """
    Search official Azerbaijani legislation.

    Returns relevant legal passages with their
    article numbers, source URLs, and citation IDs.
    """

    retriever = get_retriever()

    return retriever.search(
        question=question,
        top_k=top_k,
    )




def search_documents(
    query: str,
    company_id: str,
    top_k: int = 5,
    date: str | None = None,
    supplier: str | None = None,
):
    """Retrieve candidate accounting documents for a company."""

    return search_receipts(
        question=query,
        company_id=company_id,
        top_k=top_k,
        document_date=date,
        supplier=supplier,
    )


def get_document(
    document_id: str,
    company_id: str,
):
    """Get the complete stored document record."""

    try:
        document_id = str(uuid.UUID(document_id))
    except ValueError:
        raise ValueError("Invalid document ID")

    folder = company_folder(company_id)
    path = folder / f"{document_id}.json"

    if not path.is_file() or path.is_symlink():
        return None

    record = json.loads(
        path.read_text(encoding="utf-8")
    )

    if record.get("company_id") != company_id:
        return None

    if record.get("document_id") != document_id:
        raise ValueError("Stored document identity does not match its filename")
    return reviewed_record(record)


def ingest_document(file_path: str, company_id: str):
    """Ingest a trusted backend upload path; company_id comes from authentication.

    Calls Gemini OCR and saves an unposted, unverified receipt record. The main
    agent must never supply arbitrary server file paths from a chat message.
    """
    with _ingest_lock:
        return ingest_receipt(file_path, company_id)
