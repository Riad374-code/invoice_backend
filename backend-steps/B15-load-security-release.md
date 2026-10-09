# B15 — Yük testi, təhlükəsizlik yoxlaması, release

> Mənbə: `BACKEND.md` §15 İnkişaf ardıcıllığı
> Orijinal sətir (dəyişdirilmədən):
> `| B15 | Yük testi, təhlükəsizlik yoxlaması, release | |`
> Tam BACKEND.md: `../BACKEND.md`

---

## 1. Bu addıma aid orijinal tələblər (BACKEND.md-dən olduğu kimi, tam §14 + §11 + §16 + §2 deploy)

### §14 Test strategiyası — tam (olduğu kimi):
| Səviyyə | Nə |
|---|---|
| Unit | `accounting`, `domain` — 100% əhatə hədəfi |
| Golden | Qaimə/ƏDV qızıl faylları |
| Integration | testcontainers Postgres: repository-lər, RLS, migrations |
| API | Hər endpoint: 200 / 401 / 403 / 404 / 409 / 422 halları |
| Agent | Mock LLM ilə: icazəsiz alət rədd olunur, write → approval, prompt injection testləri |
| Load | k6: qaimə yükləmə və chat |

### §11 Təhlükəsizlik (audit dərslərindən) — tam (olduğu kimi):
| Qayda | Audit |
|---|---|
| Şifrə Argon2id, login rate limit, 2FA (istəyə bağlı) | A-01 |
| Hər handler-də `RequireAuth` + `RequirePermission` extractor | A-02 |
| `approver_id <> requester_id` (DB CHECK + kod) | A-03 |
| Status = Rust enum + state machine; etibarsız keçid → `409 CONFLICT` | A-04 |
| Tapılmayan resurs → `404`; fallback yoxdur | A-05 |
| Token müddəti dinamik, refresh rotation | A-07 |
| Lock/DB xətası → `5xx`, heç vaxt saxta uğur | A-13 |
| Secret-lər yalnız env/secret manager; start-da yoxlanır | |
| CORS: yalnız konkret origin-lər | |
| Fayl yükləmə: ölçü limiti, MIME yoxlaması, antivirus (ClamAV) | |
| PII maskalama log-larda (VÖEN, FİN, IBAN, telefon) | |
| Məlumat Azərbaycan daxilində ("Fərdi məlumatlar haqqında" Qanun) | |

### §16 Qəbul meyarları — tam (olduğu kimi):
- `cargo clippy -D warnings`, `cargo test`, integration testlər CI-da yaşıl
- OpenAPI sxemi generasiya olunur və frontend tipləri onunla sinxrondur
- Heç bir endpoint auth/icazə yoxlamasız deyil (avtomatik test ilə yoxlanır)
- `f64` pul hesablamasında istifadə olunmur (clippy lint)
- Bütün AI çıxışları `model_version` ilə saxlanılır
- Bütün yazma əməliyyatları `audit_events`-də görünür

### §2-dən aid sətirlər (olduğu kimi):
| Sahə | Seçim |
|---|---|
| Test | `cargo test`, **testcontainers** (real Postgres), **insta** (snapshot) |
| Deploy | Docker Compose (dev), Kubernetes/on-prem (prod) — məlumat Azərbaycan daxilində saxlanılır ("Fərdi məlumatlar haqqında" Qanun) |

### §1-dən aid prinsip (olduğu kimi):
> Backend **LLM-in hesabladığı rəqəmə və ya verdiyi icazəyə heç vaxt etibar etmir**.

### §12-dən aid (sağlamlıq, olduğu kimi):
| İş | Tezlik |
|---|---|
| Mənbə sağlamlığı yoxlaması | Saatlıq |

---

## 2. Detallı görüləcək işlər

### 2.1 Yük testi
- [ ] k6: qaimə yükləmə və chat ssenariləri.
- [ ] Hədəf metrikləri müəyyənləşdir və nəticələri qeyd et (p95 latency, xəta faizi).

### 2.2 Təhlükəsizlik yoxlaması (§11-dəki hər sətir tək-tək)
- [ ] A-01: Argon2id, login rate limit, 2FA.
- [ ] A-02: Hər handler-də `RequireAuth` + `RequirePermission` (avtomatik test).
- [ ] A-03: `approver_id <> requester_id` (DB CHECK + kod).
- [ ] A-04: Status enum + state machine, etibarsız → `409`.
- [ ] A-05: Tapılmayan → `404`, fallback yoxdur.
- [ ] A-07: Token müddəti dinamik, refresh rotation.
- [ ] A-13: Lock/DB xətası → `5xx`, saxta uğur yoxdur.
- [ ] Secret-lər, CORS, fayl yükləmə (ölçü/MIME/ClamAV), PII maskalama, data rezidentliyi.

### 2.3 Test matrisinin tamamlanması (§14-dəki 6 səviyyə)
- [ ] Unit 100% (`accounting`, `domain`), Golden, Integration (testcontainers: repository, RLS, migrations), API (200/401/403/404/409/422), Agent (mock LLM), Load (k6).

### 2.4 Release
- [ ] `cargo clippy -D warnings`, `cargo test`, integration CI-da yaşıl.
- [ ] OpenAPI sxemi generasiya olunur, frontend tipləri sinxrondur.
- [ ] `f64` yoxdur (clippy lint).
- [ ] Bütün AI çıxışları `model_version` ilə, bütün yazmalar `audit_events`-də.
- [ ] Docker Compose (dev), Kubernetes/on-prem (prod) deploy təsdiqi.

---

## 3. Yaradılacaq fayllar
```
backend/tests/load/k6-invoice-upload.js
backend/tests/load/k6-chat.js
backend/tests/security/checklist.md (yuxarıdakı §11 əsasında, əgər lazımdırsa)
```

---

## 4. Qəbul meyarı (§16-dakı 6 bəndin hamısı)
- [ ] clippy + test + integration CI-da yaşıl
- [ ] OpenAPI + frontend tipləri sinxron
- [ ] Heç bir endpoint auth/icazəsiz deyil
- [ ] `f64` yoxdur
- [ ] AI çıxışları `model_version` ilə
- [ ] Yazmalar `audit_events`-də
