# B8 — Chunks + embedding + hybrid search + rerank

> Mənbə: `BACKEND.md` §15 İnkişaf ardıcıllığı
> Orijinal sətir (dəyişdirilmədən):
> `| B8 | Chunks + embedding + hybrid search + rerank | RAG |`
> Tam BACKEND.md: `../BACKEND.md`

Bu addımın nəticəsi: **RAG**.

---

## 1. Bu addıma aid orijinal tələblər (BACKEND.md-dən olduğu kimi, tam §9)

### §2 Texnologiya — aid sətir (olduğu kimi):
| Sahə | Seçim |
|---|---|
| DB | **PostgreSQL 16** + **pgvector** + `pg_trgm` + `unaccent` (Azərbaycan və rus dili mətn axtarışı; `ə, ı, ğ, ş, ç, ö, ü` normallaşdırması) |

### §3 Qovluq — aid hissə (olduğu kimi):
```
│   ├── rag/                      # chunking, embedding client, hybrid search, rerank, citation
```

### §4.4-dən aid cədvəl (olduğu kimi):
| Cədvəl | Əsas sahələr |
|---|---|
| `chunks` | resource_type (`legislation`/`news`/`file`/`audit`), resource_id, version_id, article_ref, text, **embedding vector(1024)**, embedding_model, tsv (full-text) |

İndekslər (olduğu kimi):
> İndekslər: `chunks` üzərində HNSW (`vector_cosine_ops`) + GIN (`tsv`); `invoices(company_id, issue_date)`; `news_items(canonical_url)` unique; `audit_events(company_id, created_at)`.
- B8 üçün: `chunks` üzərində HNSW (`vector_cosine_ops`) + GIN (`tsv`).

### §5 API — Search (olduğu kimi):
| Qrup | Endpoint-lər (nümunə) |
|---|---|
| Search | `POST /search` (hybrid: full-text + vektor) |

### §9 RAG xidməti — tam (olduğu kimi):
1. **Sorğu yenidən yazılışı** (istəyə bağlı, LLM ilə) + dil aşkarlama
2. **Hybrid retrieval:** pgvector (cosine, top 50) + Postgres full-text (top 50) → RRF ilə birləşmə
3. **Filtrlər:** `company_id`, istifadəçi icazəsi, yurisdiksiya, **tarix** (həmin tarixdə qüvvədə olan versiya)
4. **Rerank** (model-serving) → top 8
5. Kontekst bloku: hər parça `[S1] Mənbə, maddə, versiya` etiketi ilə
6. LLM cavabı → citation-lar `chunks.id`-yə bağlanır; cavabda olmayan mənbəyə istinad edən citation silinir
7. Mənbə tapılmadıqda: "Bu sual üçün bazada mənbə tapılmadı" — hüquqi iddia qadağandır

> Retrieve olunan mətn **etibarsız girişdir**: sistem promptunda açıq qeyd + alət icazələrinə təsir edə bilməz.

### §12 Fon işləri — aid sətir (olduğu kimi):
| İş | Tezlik |
|---|---|
| Embedding növbəsi | Davamlı |

### §13 Model xidməti ilə müqavilə — B8-ə aid sətirlər (olduğu kimi):
| Endpoint | Məqsəd |
|---|---|
| `POST /v1/embeddings` | RAG |
| `POST /v1/rerank` | RAG |

---

## 2. Detallı görüləcək işlər

### 2.1 `rag` crate
- [ ] Chunking: `legislation/news/file/audit` resursları → `chunks` (`resource_type, resource_id, version_id, article_ref, text, embedding vector(1024), embedding_model, tsv`).
- [ ] Embedding client: `POST /v1/embeddings` (model-serving, OpenAI-uyğun daxili HTTP API). Hər chunk-da `embedding_model` saxla.
- [ ] Hybrid search: pgvector cosine top 50 + Postgres full-text (`pg_trgm` + `unaccent`, `ə, ı, ğ, ş, ç, ö, ü` normallaşdırması) top 50 → RRF ilə birləşmə.
- [ ] Filtrlər: `company_id` (sessiyadan), istifadəçi icazəsi, yurisdiksiya, **tarix** (həmin tarixdə qüvvədə olan versiya — `legislation_versions.valid_from/valid_to` ilə).
- [ ] Rerank: `POST /v1/rerank` → top 8.
- [ ] Citation: `[S1] Mənbə, maddə, versiya` etiketi; citation-lar `chunks.id`-yə bağlanır; cavabda olmayan mənbəyə istinad silinir.
- [ ] Sorğu yenidən yazılışı (istəyə bağlı, LLM ilə) + dil aşkarlama.
- [ ] Mənbə tapılmadıqda: `"Bu sual üçün bazada mənbə tapılmadı"` — hüquqi iddia qadağandır.
- [ ] Təhlükəsizlik: Retrieve olunan mətn **etibarsız girişdir** — sistem promptunda açıq qeyd + alət icazələrinə təsir edə bilməz.
- [ ] HNSW (`vector_cosine_ops`) + GIN (`tsv`) indeksləri.
- [ ] Embedding növbəsi davamlı fon işi.

### 2.2 API
- [ ] `POST /search` (hybrid: full-text + vektor).

---

## 3. Yaradılacaq fayllar
```
backend/crates/rag/
backend/crates/api/src/routes/search.rs
backend/migrations/000X_chunks.sql (chunks + HNSW + GIN)
```

---

## 4. Qəbul meyarı
- Hybrid retrieval + RRF + rerank top 8 işləyir.
- Tarix filtri qüvvədə olan versiyanı qaytarır.
- Citation-lar `chunks.id`-yə bağlıdır, mənbəsiz iddia yoxdur.
