# B7 — Sources + news + legislation ingestion, versiyalama

> Mənbə: `BACKEND.md` §15 İnkişaf ardıcıllığı
> Orijinal sətir (dəyişdirilmədən):
> `| B7 | Sources + news + legislation ingestion, versiyalama | |`
> Tam BACKEND.md: `../BACKEND.md`

---

## 1. Bu addıma aid orijinal tələblər (BACKEND.md-dən olduğu kimi, tam §8 + §4.4)

### §2 Texnologiya — aid sətir (olduğu kimi):
| Sahə | Seçim |
|---|---|
| HTML scraping | **reqwest** + **scraper** |
| Fon işləri | **apalis** və ya Postgres əsaslı növbə (`SKIP LOCKED`) + cron |

### §3 Qovluq — aid hissə (olduğu kimi):
```
│   ├── ingestion/                # xəbər + qanun scraper-ləri, dedupe, versiyalama
│   ├── jobs/                     # fon işləri və cron
```

### §4.4 Xəbərlər və qanunvericilik (RAG) — tam (olduğu kimi):
| Cədvəl | Əsas sahələr |
|---|---|
| `sources` | name, url, type (`official`/`news`), fetch_cron, enabled |
| `fetch_runs` | source_id, started_at, finished_at, status, items_new, error |
| `news_items` | source_id, original_url, canonical_url, content_hash, published_at, raw_text, **ai_summary**, **ai_category**, **ai_risk_level**, **ai_tags**, ai_model_version |
| `legislation_documents` | type (`code`/`law`/`decree`/`cabinet_decision`/`standard`), official_number, adopted_at, title, language |
| `legislation_versions` | document_id, version_no, valid_from, valid_to, full_text, source_url, content_hash |
| `chunks` | resource_type (`legislation`/`news`/`file`/`audit`), resource_id, version_id, article_ref, text, **embedding vector(1024)**, embedding_model, tsv (full-text) |
| `impact_findings` | news_or_version_id, affected_resource, score, explanation, status |

İndeks (olduğu kimi): `news_items(canonical_url)` unique.

Qeyd: `chunks`, `impact_findings`-də embedding/impact hissəsi B8/B13-də tamamlanır, amma cədvəl tərifləri burada dəyişdirilmədən saxlanılır.

### §5 API — News + Legislation (olduğu kimi):
| Qrup | Endpoint-lər (nümunə) |
|---|---|
| News | `GET /news`, `GET /news/{id}`, `PUT /news/{id}/read`, `PUT /news/{id}/bookmark` |
| Legislation | `GET /legislation`, `GET /legislation/{id}`, `GET /legislation/{id}/versions`, `GET /legislation/{id}/diff?from=&to=` |

### §8 Xəbər və qanunvericilik ingestion — tam (olduğu kimi):

#### 8.1 Mənbələr (başlanğıc)
- **Qanunvericilik:** e-qanun.az (Hüquqi aktların vahid elektron bazası) — Vergi Məcəlləsi, "Mühasibat uçotu haqqında" Qanun, Nazirlər Kabinetinin qərarları
- **Vergi:** taxes.gov.az (Dövlət Vergi Xidməti) — xəbərlər, izahlar, bəyannamə formaları
- **Mühasibat standartları:** Maliyyə Nazirliyi — MMUS, Hesablar Planı
- **Maliyyə bazarı + məzənnə:** CBAR (cbar.az) — gündəlik rəsmi məzənnə, normativ aktlar
- **Qanun layihələri və aktlar:** Milli Məclis, Nazirlər Kabineti, Prezident aktları
- **Sosial sığorta:** DSMF
- **Qlobal:** IFRS Foundation (MHBS) xəbərləri

> Rəsmi API olmayan yerlərdə HTML scraping; `robots.txt` və istifadə şərtlərinə riayət, sorğu tezliyi limitli.

#### 8.2 Axın
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
> Fetch xətaları `fetch_runs`-a yazılır; mənbə 24 saat yenilənməsə admin-ə xəbərdarlıq.

### §12 Fon işləri — B7-yə aid sətirlər (olduğu kimi):
| İş | Tezlik |
|---|---|
| Xəbər/qanun fetch | Hər mənbə üçün ayrıca (15 dəq – 24 saat) |
| Mənbə sağlamlığı yoxlaması | Saatlıq |

---

## 2. Detallı görüləcək işlər

### 2.1 Cədvəllər
- [ ] `sources` — `name, url, type (official/news), fetch_cron, enabled`.
- [ ] `fetch_runs` — `source_id, started_at, finished_at, status, items_new, error`.
- [ ] `news_items` — `source_id, original_url, canonical_url, content_hash, published_at, raw_text, ai_summary, ai_category, ai_risk_level, ai_tags, ai_model_version`. `canonical_url` unique.
- [ ] `legislation_documents` — `type (code/law/decree/cabinet_decision/standard), official_number, adopted_at, title, language`.
- [ ] `legislation_versions` — `document_id, version_no, valid_from, valid_to, full_text, source_url, content_hash`. Diff ilə yeni versiya, `valid_from` təyin et.

### 2.2 Ingestion crate
- [ ] `crates/ingestion/` — xəbər + qanun scraper-ləri (`reqwest` + `scraper`), dedupe (`canonical URL + content_hash`), versiyalama.
- [ ] `robots.txt` və istifadə şərtlərinə riayət, sorğu tezliyi limitli.
- [ ] `cron (source.fetch_cron) → fetch_runs` — hər mənbə üçün ayrıca (15 dəq – 24 saat).
- [ ] `raw_text` saxla (AI çıxışından AYRI).
- [ ] Fetch xətaları `fetch_runs`-a yazılır; 24 saat yenilənməsə admin-ə xəbərdarlıq.
- [ ] Mənbə sağlamlığı yoxlaması saatlıq.

### 2.3 API
- [ ] `GET /news`, `GET /news/{id}`, `PUT /news/{id}/read`, `PUT /news/{id}/bookmark`.
- [ ] `GET /legislation`, `GET /legislation/{id}`, `GET /legislation/{id}/versions`, `GET /legislation/{id}/diff?from=&to=`.

### 2.4 Sonrakı addımlara ötürmə (bu addımda tam icra olunmur, amma axın mətni qorunur)
- model-serving classify+summarize (B9/B10 ilə), chunk+embed (B8), impact analysis (B13), `tax_rates (status=proposed) + approvals` (B11/B9 ilə).

---

## 3. Yaradılacaq fayllar
```
backend/crates/ingestion/
backend/crates/api/src/routes/news.rs
backend/crates/api/src/routes/legislation.rs
backend/migrations/000X_sources_news_legislation.sql
```

---

## 4. Qəbul meyarı
- Bütün başlanğıc mənbələr (e-qanun.az, taxes.gov.az, Maliyyə Nazirliyi, CBAR, MM, NK, Prezident, DSMF, IFRS) `sources`-da.
- Dedupe işləyir, versiyalama diff ilə.
- Fetch xətaları görünür, 24 saat xəbərdarlığı işləyir.
