# B5 — `accounting` crate + golden testlər

> Mənbə: `BACKEND.md` §15 İnkişaf ardıcıllığı
> Orijinal sətir (dəyişdirilmədən):
> `| B5 | `accounting` crate + golden testlər | ƏDV, depozit hesabı, jurnal |`
> Tam BACKEND.md: `../BACKEND.md`

Bu addımın nəticəsi: **ƏDV, depozit hesabı, jurnal**.

---

## 1. Bu addıma aid orijinal tələblər (BACKEND.md-dən olduğu kimi, tam §6)

### §3 Qovluq + Qayda (olduğu kimi):
```
│   ├── domain/                   # biznes tipləri, enum-lar, state machine-lər (IO yoxdur)
│   ├── accounting/               # DETERMINISTIK mühərrik (IO yoxdur, 100% test)
│   │   └── src/
│   │       ├── vat.rs            # ƏDV hesablanması (dərəcə, azadolma, 0%)
│   │       ├── vat_deposit.rs    # ƏDV depozit hesabı ↔ uçot uzlaşdırması
│   │       ├── withholding.rs    # ödəmə mənbəyində vergi
│   │       ├── payroll.rs        # (Faza 2) gəlir vergisi, DSMF, işsizlik, icbari tibbi sığorta
│   │       ├── rounding.rs       # yuvarlaqlaşdırma qaydaları
│   │       ├── fx.rs             # valyuta çevirmə (CBAR rəsmi məzənnəsi ilə)
│   │       ├── journal.rs        # debet = kredit, hesab kodu validasiyası
│   │       ├── tax_id.rs         # VÖEN (10 rəqəm), FİN (7 simvol), AZ IBAN (28 simvol) format yoxlaması
│   │       └── rates.rs          # tarixə görə dərəcə seçimi
└── tests/
    └── golden/                   # ƏDV/qaimə qızıl test faylları
```
> **Qayda:** `accounting` və `domain` crate-ləri heç bir IO-dan (DB, HTTP) asılı deyil — təmiz funksiyalar, tam test olunur.

### §1-dən aid cümlə (olduğu kimi):
- **Deterministik mühasibat mühərriki:** ƏDV (hesablanmış / əvəzləşdirilən / depozit hesabı), ödəmə mənbəyində vergi, yuvarlaqlaşdırma, valyuta (CBAR), jurnal balansı

### §2 Texnologiya — aid sətir (olduğu kimi):
| Sahə | Seçim |
|---|---|
| Pul | **rust_decimal** — `f64` qadağandır |

### §6 Mühasibat mühərriki (deterministik) — tam (olduğu kimi):

#### 6.1 Prinsiplər
- Bütün hesablamalar `rust_decimal::Decimal` ilə.
- Dərəcələr kodda **sabit yazılmır**: `tax_rates` cədvəlindən **əməliyyat tarixinə görə** seçilir.
- Yuvarlaqlaşdırma qaydası yurisdiksiyaya görə konfiqurasiya olunur (sətir səviyyəsində və ya cəm səviyyəsində).
- Hər nəticə `explanation` qaytarır: hansı dərəcə, hansı qanun mənbəyi, hansı addımlar.

#### 6.2 Funksiyalar
```
vat::calculate(net, rate_code, date) -> VatResult { rate, vat, gross, rate_source_id }
vat::reverse(gross, rate_code, date)               -> VatResult
withholding::calculate(amount, code, date)         -> WithholdingResult   // ödəmə mənbəyində vergi
vat_deposit::reconcile(statement, ledger)          -> Vec<DepositMatch>
journal::validate(lines)                           -> Result<(), JournalError> // Σdebet = Σkredit
journal::from_invoice(invoice, mapping)            -> Vec<JournalLine>       // təklif
tax_id::validate_voen / validate_fin / validate_iban_az
fx::convert(amount, from, to, date)                -> Money
invoice::check(invoice) -> Vec<InvoiceIssue>       // cəm, dərəcə, tarix, VÖEN, dublikat
```

#### 6.3 Test
- `tests/golden/` — yüzlərlə real formatlı (anonimləşdirilmiş) qaimə + gözlənilən nəticə
- Property-based testlər (`proptest`): `gross == net + vat`, jurnal balansı həmişə 0
- Dərəcə dəyişikliyi sərhədləri: dəyişiklik tarixindən bir gün əvvəl/sonra

### §4.2-dən B5-ə aid cədvəl (olduğu kimi):
| Cədvəl | Əsas sahələr |
|---|---|
| `tax_rates` | tax_type (`VAT`, `PROFIT`, `INCOME`, `WITHHOLDING`, `SIMPLIFIED`, `SOCIAL`…), code, rate NUMERIC, valid_from, valid_to, legal_source_id, status (`proposed`/`active`) |

### §14 Test strategiyası — B5-ə aid sətirlər (olduğu kimi):
| Səviyyə | Nə |
|---|---|
| Unit | `accounting`, `domain` — 100% əhatə hədəfi |
| Golden | Qaimə/ƏDV qızıl faylları |

---

## 2. Detallı görüləcək işlər

### 2.1 Fayllar
- [ ] `crates/accounting/src/vat.rs` — ƏDV hesablanması (dərəcə, azadolma, 0%).
- [ ] `crates/accounting/src/vat_deposit.rs` — ƏDV depozit hesabı ↔ uçot uzlaşdırması.
- [ ] `crates/accounting/src/withholding.rs` — ödəmə mənbəyində vergi.
- [ ] `crates/accounting/src/payroll.rs` — (Faza 2) gəlir vergisi, DSMF, işsizlik, icbari tibbi sığorta (stub, amma fayl mövcud olmalıdır).
- [ ] `crates/accounting/src/rounding.rs` — yuvarlaqlaşdırma qaydaları (sətir vs cəm səviyyəsi konfiqurasiya).
- [ ] `crates/accounting/src/fx.rs` — valyuta çevirmə (CBAR rəsmi məzənnəsi ilə).
- [ ] `crates/accounting/src/journal.rs` — debet = kredit, hesab kodu validasiyası.
- [ ] `crates/accounting/src/tax_id.rs` — VÖEN (10 rəqəm), FİN (7 simvol), AZ IBAN (28 simvol) format yoxlaması.
- [ ] `crates/accounting/src/rates.rs` — tarixə görə dərəcə seçimi (`tax_rates` cədvəlindən, kodda sabit YOXDUR).
- [ ] Bütün hesablamalar `rust_decimal::Decimal` ilə, `f64` qadağandır (clippy lint ilə yoxlanır).
- [ ] Hər nəticə `explanation` qaytarır: hansı dərəcə, hansı qanun mənbəyi, hansı addımlar.

### 2.2 Funksiya imzaları (yuxarıdakı §6.2-dəki kimi, dəyişdirilmədən):
- [ ] `vat::calculate`, `vat::reverse`, `withholding::calculate`, `vat_deposit::reconcile`, `journal::validate`, `journal::from_invoice`, `tax_id::validate_voen / validate_fin / validate_iban_az`, `fx::convert`, `invoice::check`.

### 2.3 Testlər
- [ ] `tests/golden/` — yüzlərlə real formatlı (anonimləşdirilmiş) qaimə + gözlənilən nəticə (başlanğıc üçün struktur + ilk nümunələr).
- [ ] `proptest`: `gross == net + vat`, jurnal balansı həmişə 0.
- [ ] Dərəcə dəyişikliyi sərhədləri: dəyişiklik tarixindən bir gün əvvəl/sonra.
- [ ] Unit əhatə hədəfi 100% (`accounting`, `domain`).

---

## 3. Yaradılacaq fayllar
```
backend/crates/accounting/src/vat.rs
backend/crates/accounting/src/vat_deposit.rs
backend/crates/accounting/src/withholding.rs
backend/crates/accounting/src/payroll.rs
backend/crates/accounting/src/rounding.rs
backend/crates/accounting/src/fx.rs
backend/crates/accounting/src/journal.rs
backend/crates/accounting/src/tax_id.rs
backend/crates/accounting/src/rates.rs
backend/tests/golden/
```

---

## 4. Qəbul meyarı
- `accounting` və `domain` heç bir IO-dan asılı deyil.
- `f64` yoxdur.
- Golden + proptest + sərhəd testləri yaşıl.
