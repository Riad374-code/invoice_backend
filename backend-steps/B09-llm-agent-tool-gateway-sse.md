# B9 — LLM client + Agent + Tool Gateway + SSE

> Mənbə: `BACKEND.md` §15 İnkişaf ardıcıllığı
> Orijinal sətir (dəyişdirilmədən):
> `| B9 | LLM client + Agent + Tool Gateway + SSE | Assistent |`
> Tam BACKEND.md: `../BACKEND.md`

Bu addımın nəticəsi: **Assistent**.

---

## 1. Bu addıma aid orijinal tələblər (BACKEND.md-dən olduğu kimi, tam §10 + §4.5 + §13)

### §1-dən aid (olduğu kimi):
- AI Agent orkestratoru və **alət qapısı (Tool Gateway)** — model yalnız təklif edir, server yoxlayıb icra edir
- RAG retrieval (pgvector), mənbələrin (citation) qurulması
- Model xidmətinə (`model-training/serving`) daxili şəbəkə üzərindən müraciət
> Backend **LLM-in hesabladığı rəqəmə və ya verdiyi icazəyə heç vaxt etibar etmir**.

### §3 Qovluq — aid hissələr (olduğu kimi):
```
│   ├── llm/                      # model-serving client (OpenAI-uyğun API), prompt şablonları
│   ├── agent/                    # orkestrator, tool registry, tool gateway, approvals
```

### §4.5 AI / Agent (olduğu kimi, tam):
| Cədvəl | Əsas sahələr |
|---|---|
| `conversations`, `messages` | role, content, citations JSONB, model_version |
| `tool_runs` | tool_name, requested_args, validated_args, status, result_summary, approval_id, duration_ms, idempotency_key |
| `feedback_events` | message_id / invoice_line_id / journal_line_id, kind (`thumbs`, `correction`, `approval_decision`), before, after, user_id — **model train məlumatının mənbəyi** |
| `model_versions` | name, kind (llm/embedding/classifier), artifact_uri, status (`candidate/canary/production/retired`), eval_report |

### §5 API — Assistant + Approvals + Audit (olduğu kimi):
| Qrup | Endpoint-lər (nümunə) |
|---|---|
| Assistant | `POST /conversations`, `GET /conversations`, `POST /conversations/{id}/messages` → **SSE stream**, `POST /messages/{id}/feedback` |
| Approvals | `GET /approvals`, `POST /approvals/{id}/decide` |
| Audit | `GET /audit-events` |

### §10 Agent orkestratoru və Tool Gateway — tam (olduğu kimi):

#### 10.1 Axın
```
user message
  → orchestrator: system prompt + tarixçə + alət sxemləri → LLM
  → LLM tool_call təklif edir
  → Tool Gateway:
       1. alət reyestrdə var?
       2. arqumentlər JSON Schema ilə validasiya
       3. company_id sessiyadan əlavə olunur (modeldən YOX)
       4. istifadəçinin icazəsi var?
       5. risk səviyyəsi: read → icra; write → preview + approvals (APPROVAL_REQUIRED)
       6. idempotency key
       7. tool_runs-a yazılır (həmişə, rədd edilsə də)
  → nəticə LLM-ə qaytarılır → final cavab
  → hər addım SSE event kimi frontend-ə
```
> Maksimum addım sayı (məs. 8), timeout, token limiti.

#### 10.2 Alətlər
| Alət | Risk | Qeyd |
|---|---|---|
| `legislation.search`, `legislation.get`, `legislation.diff` | read | |
| `news.search`, `news.get` | read | |
| `files.search`, `files.read_text` | read | |
| `invoice.get`, `invoice.list`, `invoice.validate` | read | |
| `vat.calculate`, `withholding.calculate`, `fx.convert` | read | Deterministik mühərrik |
| `vat_deposit.reconcile` | read | Depozit hesabı ↔ uçot |
| `import.preview` (1C / e-taxes / bank) | read | İmport önbaxışı |
| `import.commit` | moderate-write | Təsdiq məcburi |
| `onec.export_entries` | low-write | 1C üçün fayl yaradır |
| `vat.period_summary` | read | |
| `ledger.suggest_entries` | read | Yalnız təklif |
| `ledger.submit_entries` | moderate-write | Təsdiq məcburi |
| `excel.profile`, `excel.query` | read | |
| `excel.generate_report` | low-write | Yeni fayl, orijinal dəyişmir |
| `reconcile.run` | low-write | Nəticə təklif kimi |
| `vat_return.draft` | low-write | Qaralama |
| `mhbs.classify` | read | MHBS/MMUS təsnifatı təklifi |

> Qadağan: ixtiyari SQL, shell, fayl sistemi yolları, istifadəçi idarəetməsi, kalıcı silmə, toplu yazma.

### §13 Model xidməti ilə müqavilə — B9-a aid (olduğu kimi, tam saxlanılır):
> Backend `model-training/serving`-ə **OpenAI-uyğun** daxili HTTP API ilə müraciət edir (provider dəyişdirmək asan olsun):
| Endpoint | Məqsəd |
|---|---|
| `POST /v1/chat/completions` (stream, tools) | Assistent / agent |
| `POST /v1/embeddings` | RAG |
| `POST /v1/rerank` | RAG |
| `POST /v1/extract/invoice` | Qaimə çıxarışı (JSON schema-ya uyğun) |
| `POST /v1/ocr` | Skan sənədlər |
| `POST /v1/classify/news` | Kateqoriya, risk, teqlər |
| `POST /v1/classify/account` | Hesab kodu təklifi |
| `GET /v1/models` | Aktiv versiyalar |
> Hər AI nəticəsi ilə `model_version` saxlanılır (izlənə bilmə və rollback üçün).

### §14-dən aid (olduğu kimi):
| Səviyyə | Nə |
|---|---|
| Agent | Mock LLM ilə: icazəsiz alət rədd olunur, write → approval, prompt injection testləri |

### §4 giriş (olduğu kimi, Tool Gateway üçün kritik):
> `company_id` **həmişə sessiyadan** götürülür, heç vaxt request body-dən və ya model arqumentindən (multi-tenant təhlükəsizliyi).

---

## 2. Detallı görüləcək işlər

### 2.1 `llm` crate
- [ ] `model-training/serving`-ə OpenAI-uyğun daxili HTTP client: `POST /v1/chat/completions` (stream, tools), prompt şablonları.
- [ ] Hər AI nəticəsi ilə `model_version` saxla.

### 2.2 `agent` crate
- [ ] Orkestrator: system prompt + tarixçə + alət sxemləri → LLM.
- [ ] Tool registry + Tool Gateway (yuxarıdakı 7 addım dəyişdirilmədən):
  1. reyestr yoxlaması, 2. JSON Schema validasiya, 3. `company_id` sessiyadan (modeldən YOX), 4. icazə yoxlaması, 5. risk: read → icra / write → preview + approvals (`APPROVAL_REQUIRED`), 6. idempotency key, 7. `tool_runs`-a həmişə yaz (rədd edilsə də).
- [ ] Bütün 10.2 alətlərini qeyd et (risk səviyyələri ilə), qadağan siyahısına əməl et.
- [ ] Maksimum addım sayı (məs. 8), timeout, token limiti.
- [ ] Backend LLM-in hesabladığı rəqəmə və ya verdiyi icazəyə heç vaxt etibar etmir — `vat.calculate` kimi rəqəmlər deterministik mühərrikdən gəlir.

### 2.3 DB + API
- [ ] `conversations, messages (role, content, citations JSONB, model_version)`, `tool_runs (tool_name, requested_args, validated_args, status, result_summary, approval_id, duration_ms, idempotency_key)`.
- [ ] `POST /conversations`, `GET /conversations`, `POST /conversations/{id}/messages` → **SSE stream** (hər addım SSE event), `POST /messages/{id}/feedback`, `GET /approvals`, `POST /approvals/{id}/decide`, `GET /audit-events`.

### 2.4 Test
- [ ] Mock LLM ilə: icazəsiz alət rədd olunur, write → approval, prompt injection testləri.

---

## 3. Yaradılacaq fayllar
```
backend/crates/llm/
backend/crates/agent/ (orkestrator, tool registry, tool gateway, approvals)
backend/crates/api/src/routes/assistant.rs (conversations + SSE)
backend/crates/api/src/routes/approvals.rs
backend/crates/api/src/routes/audit.rs
```

---

## 4. Qəbul meyarı
- Assistent SSE ilə addım-addım cavab verir, citation-lar `chunks.id`-yə bağlıdır.
- `company_id` modeldən gələ bilmir, icazəsiz alət rədd olunur, write təsdiqsiz icra olunmur.
- Bütün tool cəhdləri `tool_runs`-da.
