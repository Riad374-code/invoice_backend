# B11 — VAT periods + bəyannamə qaralaması + ledger

> Mənbə: `BACKEND.md` §15 İnkişaf ardıcıllığı
> Orijinal sətir (dəyişdirilmədən):
> `| B11 | VAT periods + bəyannamə qaralaması + ledger | |`
> Tam BACKEND.md: `../BACKEND.md`

---

## 1. Bu addıma aid orijinal tələblər (BACKEND.md-dən olduğu kimi)

### §3 Qovluq — aid hissələr (olduğu kimi):
```
│   ├── accounting/               # DETERMINISTIK mühərrik (IO yoxdur, 100% test)
│   │   └── src/
│   │       ├── vat.rs            # ƏDV hesablanması (dərəcə, azadolma, 0%)
│   │       ├── vat_deposit.rs    # ƏDV depozit hesabı ↔ uçot uzlaşdırması
```

### §4.2 Mühasibat — B11-ə aid cədvəllər (olduğu kimi, tam):
| Cədvəl | Əsas sahələr |
|---|---|
| `tax_rates` | tax_type (`VAT`, `PROFIT`, `INCOME`, `WITHHOLDING`, `SIMPLIFIED`, `SOCIAL`…), code, rate NUMERIC, valid_from, valid_to, legal_source_id, status (`proposed`/`active`) |
| `chart_of_accounts`, `accounts` | code (məs. 211, 221, 223, 241, 521, 531, 601), name_az/ru/en, type, parent_id |
| `tax_calendar` | tax_type, period, due_date, legal_source_id — son tarixlər kodda deyil, burada |
| `journal_entries`, `journal_lines` | date, description, status (`proposed`/`approved`/`posted`), account_id, debit, credit, source (invoice/manual/ai) |
| `vat_periods`, `vat_returns` | period, output_vat, input_vat, exempt_turnover, zero_rated_turnover, payable, deposit_balance, status, draft_file_id |
| `vat_deposit_statements`, `vat_deposit_lines` | dövr, əməliyyat, məbləğ, uyğunlaşdırılmış qaimə/ödəniş |
| `fx_rates` | currency, date, rate, source (`CBAR`) |

### §5 API — VAT + Ledger (olduğu kimi):
| Qrup | Endpoint-lər (nümunə) |
|---|---|
| VAT | `GET /vat/periods`, `GET /vat/periods/{p}/summary`, `POST /vat/periods/{p}/draft-return`, `GET /tax-rates` |
| Ledger | `GET /journal`, `POST /journal/{id}/submit`, `GET /accounts` |

### §6.2-dən aid funksiyalar (olduğu kimi):
```
vat::calculate(net, rate_code, date) -> VatResult { rate, vat, gross, rate_source_id }
vat::reverse(gross, rate_code, date)               -> VatResult
vat_deposit::reconcile(statement, ledger)          -> Vec<DepositMatch>
journal::validate(lines)                           -> Result<(), JournalError> // Σdebet = Σkredit
journal::from_invoice(invoice, mapping)            -> Vec<JournalLine>       // təklif
fx::convert(amount, from, to, date)                -> Money
```

### §6.1-dən aid (olduğu kimi):
- Dərəcələr kodda **sabit yazılmır**: `tax_rates` cədvəlindən **əməliyyat tarixinə görə** seçilir.
- Hər nəticə `explanation` qaytarır: hansı dərəcə, hansı qanun mənbəyi, hansı addımlar.

### §10.2 Alətlər — B11-ə aid (olduğu kimi):
| Alət | Risk | Qeyd |
|---|---|---|
| `vat.calculate` | read | Deterministik mühərrik |
| `vat_deposit.reconcile` | read | Depozit hesabı ↔ uçot |
| `vat.period_summary` | read | |
| `ledger.suggest_entries` | read | Yalnız təklif |
| `ledger.submit_entries` | moderate-write | Təsdiq məcburi |
| `vat_return.draft` | low-write | Qaralama |

### §8.2-dən aid sətir (olduğu kimi, vergi dərəcəsi dəyişikliyi):
> → vergi dərəcəsi dəyişikliyi aşkarlanarsa → tax_rates (status=proposed) + approvals

### §12-dən aid (olduğu kimi):
| İş | Tezlik |
|---|---|
| Məzənnə (CBAR) | Gündəlik |
| Bəyannamə tarixi xatırlatması | Gündəlik |

---

## 2. Detallı görüləcək işlər

### 2.1 VAT periods
- [ ] `vat_periods, vat_returns` — `period, output_vat, input_vat, exempt_turnover, zero_rated_turnover, payable, deposit_balance, status, draft_file_id`.
- [ ] `GET /vat/periods`, `GET /vat/periods/{p}/summary` (`vat.period_summary`), `POST /vat/periods/{p}/draft-return` (`vat_return.draft` — qaralama, `draft_file_id` ilə fayl yaradır).
- [ ] Hesablama yalnız deterministik mühərrikdən (`vat::calculate/reverse`), dərəcə `tax_rates`-dən əməliyyat tarixinə görə, `explanation` ilə.
- [ ] `tax_rates.status=proposed` → approvals ilə aktivləşir.
- [ ] `GET /tax-rates` — `tax_type (VAT, PROFIT, INCOME, WITHHOLDING, SIMPLIFIED, SOCIAL…), code, rate, valid_from, valid_to, legal_source_id, status (proposed/active)`.

### 2.2 Ledger
- [ ] `chart_of_accounts, accounts` — `code (211, 221, 223, 241, 521, 531, 601…), name_az/ru/en, type, parent_id`.
- [ ] `journal_entries, journal_lines` — `date, description, status (proposed/approved/posted), account_id, debit, credit, source (invoice/manual/ai)`.
- [ ] `journal::validate` (Σdebet = Σkredit), `journal::from_invoice` (təklif).
- [ ] `GET /journal`, `POST /journal/{id}/submit` (`ledger.submit_entries`, təsdiq məcburi), `GET /accounts`.
- [ ] Status Rust enum + state machine; etibarsız keçid → `409 CONFLICT` (§11 A-04 olduğu kimi).

### 2.3 Depozit + FX + Təqvim
- [ ] `vat_deposit_statements, vat_deposit_lines` — dövr, əməliyyat, məbləğ, uyğunlaşdırılmış qaimə/ödəniş; `vat_deposit::reconcile`.
- [ ] `fx_rates` — `currency, date, rate, source (CBAR)`; `fx::convert`; məzənnə gündəlik job.
- [ ] `tax_calendar` — `tax_type, period, due_date, legal_source_id` — son tarixlər kodda deyil, burada; bəyannamə xatırlatması gündəlik.

---

## 3. Yaradılacaq fayllar
```
backend/crates/api/src/routes/vat.rs (GET /vat/periods, GET /vat/periods/{p}/summary, POST /vat/periods/{p}/draft-return, GET /tax-rates)
backend/crates/api/src/routes/ledger.rs (GET /journal, POST /journal/{id}/submit, GET /accounts)
backend/migrations/000X_vat_ledger.sql
```

---

## 4. Qəbul meyarı
- VAT summary payable düzgün (output - input, exempt/zero-rated ayrı).
- Jurnal balanssız təsdiqlənmir.
- Draft-return qaralama fayl yaradır, orijinalı dəyişmir.
