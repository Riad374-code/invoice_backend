# B14 — Feedback export + model versiyaları + admin

> Mənbə: `BACKEND.md` §15 İnkişaf ardıcıllığı
> Orijinal sətir (dəyişdirilmədən):
> `| B14 | Feedback export + model versiyaları + admin | |`
> Tam BACKEND.md: `../BACKEND.md`

---

## 1. Bu addıma aid orijinal tələblər (BACKEND.md-dən olduğu kimi)

### §4.5-dən aid cədvəllər (olduğu kimi, tam):
| Cədvəl | Əsas sahələr |
|---|---|
| `feedback_events` | message_id / invoice_line_id / journal_line_id, kind (`thumbs`, `correction`, `approval_decision`), before, after, user_id — **model train məlumatının mənbəyi** |
| `model_versions` | name, kind (llm/embedding/classifier), artifact_uri, status (`candidate/canary/production/retired`), eval_report |

Kontekst üçün eyni cədvəldən (olduğu kimi):
| Cədvəl | Əsas sahələr |
|---|---|
| `conversations`, `messages` | role, content, citations JSONB, model_version |

### §5 API — Assistant feedback + Admin (olduğu kimi):
| Qrup | Endpoint-lər (nümunə) |
|---|---|
| Assistant | `POST /conversations`, `GET /conversations`, `POST /conversations/{id}/messages` → **SSE stream**, `POST /messages/{id}/feedback` |
| Admin | `/admin/users`, `/admin/roles`, `/admin/sources`, `/admin/tax-rates`, `/admin/models`, `/admin/health` |

### §12 Fon işləri — B14-ə aid sətirlər (olduğu kimi):
| İş | Tezlik |
|---|---|
| Feedback export (anonim) → `model-training` | Həftəlik |
| Approval expiry | Saatlıq |

### §13 Model xidməti — B14-ə aid (olduğu kimi):
| Endpoint | Məqsəd |
|---|---|
| `GET /v1/models` | Aktiv versiyalar |

Həmçinin (olduğu kimi):
> Hər AI nəticəsi ilə `model_version` saxlanılır (izlənə bilmə və rollback üçün).

### §11-dən aid kontekst (olduğu kimi):
| Qayda | Audit |
|---|---|
| Məlumat Azərbaycan daxilində ("Fərdi məlumatlar haqqında" Qanun) | |

---

## 2. Detallı görüləcək işlər

### 2.1 Feedback
- [ ] `POST /messages/{id}/feedback` — artıq B9-da skelet varsa, burada tam: `feedback_events` — `message_id / invoice_line_id / journal_line_id, kind (thumbs, correction, approval_decision), before, after, user_id`.
- [ ] Qeyd (olduğu kimi): **model train məlumatının mənbəyi**.
- [ ] Feedback export (anonim) → `model-training` — həftəlik fon işi. Anonimləşdirmə + PII maskalama (VÖEN, FİN, IBAN, telefon — §11-dəki kimi). Məlumat Azərbaycan daxilində qalır.

### 2.2 Model versiyaları
- [ ] `model_versions` — `name, kind (llm/embedding/classifier), artifact_uri, status (candidate/canary/production/retired), eval_report`.
- [ ] `GET /v1/models` (model-serving-dən aktiv versiyalar) + admin-də `/admin/models`.
- [ ] Hər AI nəticəsi ilə `model_version` saxlanılır (B7 `news_items.ai_model_version`, B8 `chunks.embedding_model`, B9 `messages.model_version` — burada yoxlanılır).

### 2.3 Admin
- [ ] `/admin/users`, `/admin/roles`, `/admin/sources`, `/admin/tax-rates`, `/admin/models`, `/admin/health` (prefiks `/api/v1` ilə).
- [ ] Approval expiry — saatlıq fon işi (`approvals.expires_at, decided_at` ilə).

---

## 3. Yaradılacaq fayllar
```
backend/crates/api/src/routes/admin.rs (/admin/users, /admin/roles, /admin/sources, /admin/tax-rates, /admin/models, /admin/health)
backend/crates/jobs/src/feedback_export.rs (həftəlik, anonim)
backend/crates/jobs/src/approval_expiry.rs (saatlıq)
backend/migrations/000X_feedback_models.sql (əgər B9-da yaradılmayıbsa)
```

---

## 4. Qəbul meyarı
- Feedback yazılır və həftəlik anonim export işləyir.
- Model versiyaları `candidate/canary/production/retired` ilə idarə olunur.
- Admin endpoint-ləri yalnız icazəli rollara açıqdır.
- Approval müddəti bitəndə expiry işləyir.
