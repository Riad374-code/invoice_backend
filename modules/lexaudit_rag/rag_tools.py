from search_legal import LegalRetriever
import json
import uuid
import threading

from receipt_rag import search_receipts, company_folder, ingest_receipt
from receipt_validation import reviewed_record
import numpy as np
from collections import defaultdict
from sklearn.feature_extraction.text import TfidfVectorizer

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


_hybrid_cache = None


def get_hybrid_index():
    global _hybrid_cache

    if _hybrid_cache is not None:
        return _hybrid_cache

    retriever = get_retriever()
    chunks = retriever.chunks

    print("Building hybrid legal search index...")

    vectorizer = TfidfVectorizer(
        analyzer="char",
        ngram_range=(3, 5),
        min_df=2,
        max_features=100000,
    )

    matrix = vectorizer.fit_transform([
        c["embedding_text"] for c in chunks
    ])

    article_indices = defaultdict(list)

    for i, chunk in enumerate(chunks):
        article_indices[chunk["article"]].append(i)

    _hybrid_cache = (
        retriever,
        vectorizer,
        matrix,
        dict(article_indices),
    )

    return _hybrid_cache


def search_regulations(
    question: str,
    top_k: int = 8,
) -> list[dict]:

    retriever, vectorizer, matrix, article_indices = (
        get_hybrid_index()
    )

    # 1. E5 semantic similarity
    query_vector = retriever.model.encode(
        "query: " + question,
        normalize_embeddings=True,
        convert_to_numpy=True,
    )

    e5_scores = retriever.embeddings @ query_vector

    # 2. TF-IDF lexical similarity
    keyword_query = vectorizer.transform([question])

    tfidf_scores = (
        keyword_query @ matrix.T
    ).toarray().ravel()

    # 3. Aggregate chunk scores into article scores
    e5_article_scores = {}
    tfidf_article_scores = {}

    for article, indices in article_indices.items():
        e5_article_scores[article] = max(
            float(e5_scores[i]) for i in indices
        )

        tfidf_article_scores[article] = max(
            float(tfidf_scores[i]) for i in indices
        )

    depth = max(10, top_k)

    e5_ranking = sorted(
        article_indices,
        key=lambda a: e5_article_scores[a],
        reverse=True,
    )[:depth]

    tfidf_ranking = sorted(
        article_indices,
        key=lambda a: tfidf_article_scores[a],
        reverse=True,
    )[:depth]

    # 4. Reciprocal Rank Fusion
    rrf_scores = defaultdict(float)

    for ranking in (e5_ranking, tfidf_ranking):
        for rank, article in enumerate(ranking, 1):
            rrf_scores[article] += 1.0 / (60 + rank)

    final_articles = sorted(
        rrf_scores,
        key=lambda a: (-rrf_scores[a], a),
    )[:top_k]

    # 5. Return supporting passages
    results = []

    for article in final_articles:
        indices = article_indices[article]

        semantic_idx = max(
            indices,
            key=lambda i: e5_scores[i],
        )

        keyword_idx = max(
            indices,
            key=lambda i: tfidf_scores[i],
        )

        chunk = retriever.chunks[semantic_idx]

        # Include lexical evidence if it differs.
        evidence_indices = list(dict.fromkeys([
            semantic_idx,
            keyword_idx,
        ]))

        passages = [
            {
                "id": retriever.chunks[i]["id"],
                "text": retriever.chunks[i]["text"],
            }
            for i in evidence_indices
        ]

        results.append({
            "id": chunk["id"],
            "article": article,
            "title": chunk["article_title"],
            "text": chunk["text"],
            "source_url": chunk["source_url"],
            "score": float(rrf_scores[article]),
            "score_type": "rrf",
            "passages": passages,
        })

    return results




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
