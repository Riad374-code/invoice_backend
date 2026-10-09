# B13 — Impact analysis + bildirişlər

> Mənbə: `BACKEND.md` §15 İnkişaf ardıcıllığı
> Orijinal sətir (dəyişdirilmədən):
> `| B13 | Impact analysis + bildirişlər | |`
> Tam BACKEND.md: `../BACKEND.md`

---

## 1. Bu addıma aid orijinal tələblər (BACKEND.md-dən olduğu kimi)

### §4.4-dən aid cədvəl (olduğu kimi):
| Cədvəl | Əsas sahələr |
|---|---|
| `impact_findings` | news_or_version_id, affected_resource, score, explanation, status |

### §8.2 Axın — B13-ə aid hissə (olduğu kimi, tam mətn saxlanılır):
```
cron (source.fetch_cron) → fetch_runs
  → yeni linklər → canonical URL + content_hash dedupe
  → raw_text saxla (AI çıxışından AYRI)
  → model-serving: classify (kateqoriya, risk, teqlər) + summarize
  → chunk + embed
  → qanun mətni isə: əvvəlki versiya ilə diff → legislation_versions (valid_from)
  → impact analysis: yeni chunk-lar ↔ şirkətin files/audits/records chunk-ları (vektor oxşarlığı + rerank)
       → impact_findings → Dashboard bildirişi
  → vergi dərəcəsi dəyişikliyi aşkarlanarsa → tax_rates (status=proposed) + approvals
```

### §12 Fon işləri — B13-ə aid sətir (olduğu kimi):
| İş | Tezlik |
|---|---|
| Təsir analizi | Yeni xəbər/versiya gələndə |

### §4.4-dən əlaqəli cədvəllər (kontekst üçün olduğu kimi, dəyişdirilmədən):
| Cədvəl | Əsas sahələr |
|---|---|
| `news_items` | source_id, original_url, canonical_url, content_hash, published_at, raw_text, **ai_summary**, **ai_category**, **ai_risk_level**, **ai_tags**, ai_model_version |
| `legislation_versions` | document_id, version_no, valid_from, valid_to, full_text, source_url, content_hash |
| `chunks` | resource_type (`legislation`/`news`/`file`/`audit`), resource_id, version_id, article_ref, text, **embedding vector(1024)**, embedding_model, tsv (full-text) |

---

## 2. Detallı görüləcək işlər

### 2.1 Impact analysis
- [ ] Tetikleyici: yeni xəbər/versiya gələndə (fon işi).
- [ ] Giriş: yeni chunk-lar ↔ şirkətin `files/audits/records` chunk-ları.
- [ ] Metod: vektor oxşarlığı + rerank (B8-dəki `rag` crate-dən istifadə).
- [ ] Nəticə: `impact_findings` — `news_or_version_id, affected_resource, score, explanation, status`.
- [ ] Çıxış: Dashboard bildirişi (frontend `FRONTEND.md`-ə ötürülür, backend-də API + SSE/WebSocket və ya polling üçün hazır status).

### 2.2 Vergi dərəcəsi dəyişikliyi qolu
- [ ] Əgər təsir vergi dərəcəsi dəyişikliyidirsə → `tax_rates (status=proposed) + approvals` (§8.2-dəki kimi). Bu, B11/B9 ilə inteqrasiyadır.

---

## 3. Yaradılacaq fayllar
```
backend/crates/jobs/src/impact_analysis.rs (və ya crates/rag/src/impact.rs — yerləşdirmə qərarı)
backend/crates/api/src/routes/impact.rs (əgər endpoint lazımdırsa; ən azı Dashboard bildirişi üçün oxuma API-si)
backend/migrations/000X_impact.sql (əgər B7-də yaradılmayıbsa: impact_findings)
```

---

## 4. Qəbul meyarı
- Yeni xəbər/versiya → avtomatik `impact_findings` yaranır (`score, explanation, status` ilə).
- Dashboard bildirişi üçün API-dən oxuna bilir.
- Dərəcə dəyişikliyi `tax_rates=proposed` + approval yaradır.
