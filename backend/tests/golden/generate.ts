import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  bp,
  fmtCents,
  lineNetCents,
  parseCents,
  refTotals,
  vatFromGross,
  vatOf,
  type Mode,
  type RefLine,
} from './reference.js';

/**
 * Golden korpusu generasiya edir. Gözlənilən dəyərlər YALNIZ reference.ts-dən (BigInt) gəlir,
 * mühasibat mühərrikindən yox. Çıxış deterministikdir (sabit seed); golden.test.ts faylların
 * generatorla sinxron olduğunu və mühərrikin onlarla üst-üstə düşdüyünü yoxlayır.
 *
 *   npm run golden:generate
 *
 * Şirkət adları, VÖEN-lər və nömrələr UYDURMA (anonimləşdirilmiş) nümunələrdir; dərəcələr isə
 * real qanunvericiliyi deyil, test dərəcə cədvəlini əks etdirir.
 */

export const RATES = [
  {
    id: 'vat-std-old',
    taxType: 'VAT',
    code: 'STANDARD',
    ratePercent: '18',
    validFrom: '2001-01-01',
    validTo: '2030-06-30',
    legalSourceId: 'src-tax-code',
    status: 'active',
    treatment: null,
  },
  {
    id: 'vat-std-new',
    taxType: 'VAT',
    code: 'STANDARD',
    ratePercent: '20',
    validFrom: '2030-07-01',
    validTo: null,
    legalSourceId: 'src-amendment',
    status: 'active',
    treatment: null,
  },
  {
    id: 'vat-reduced',
    taxType: 'VAT',
    code: 'REDUCED',
    ratePercent: '8.5',
    validFrom: '2001-01-01',
    validTo: null,
    legalSourceId: null,
    status: 'active',
    treatment: null,
  },
  {
    id: 'vat-zero',
    taxType: 'VAT',
    code: 'ZERO',
    ratePercent: '0',
    validFrom: '2001-01-01',
    validTo: null,
    legalSourceId: null,
    status: 'active',
    treatment: 'zero_rated',
  },
  {
    id: 'vat-exempt',
    taxType: 'VAT',
    code: 'EXEMPT',
    ratePercent: '0',
    validFrom: '2001-01-01',
    validTo: null,
    legalSourceId: null,
    status: 'active',
    treatment: 'exempt',
  },
] as const;

/** Tarixdə qüvvədə olan dərəcə (referans tərəfdən müstəqil seçim). */
function rateOn(
  code: string,
  date: string,
): { bp: bigint; taxable: boolean; id: string; treatment: string } {
  const r = RATES.filter(
    (x) => x.code === code && x.validFrom <= date && (x.validTo === null || date <= x.validTo),
  );
  if (r.length !== 1) throw new Error(`rate ${code} on ${date}: ${r.length}`);
  const rate = r[0]!;
  const rateBp = bp(rate.ratePercent);
  const treatment = rate.treatment ?? (rateBp > 0n ? 'taxable' : 'zero_rated');
  return { bp: rateBp, taxable: treatment === 'taxable', id: rate.id, treatment };
}

// -------------------------------------------------------------------- PRNG
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const makeRng = (seed: number) => {
  const next = mulberry32(seed);
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    int,
    pick: <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!,
    chance: (p: number) => next() < p,
  };
};

const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const centsStr = (c: bigint) => fmtCents(c);

// ------------------------------------------------------------ vat.calculate / reverse
const MODES: Mode[] = ['HALF_UP', 'HALF_EVEN', 'UP', 'DOWN'];
const CODES = ['STANDARD', 'REDUCED', 'ZERO', 'EXEMPT'];
const BOUNDARY_DATES = ['2030-06-29', '2030-06-30', '2030-07-01', '2030-07-02'];

function vatCases() {
  const rng = makeRng(20301001);
  const calc: unknown[] = [];
  const rev: unknown[] = [];

  // Əl ilə yoxlanmış əsas nümunələr (hesabat: tam qəpik)
  const hand: Array<[string, string, string, Mode]> = [
    ['100.00', 'STANDARD', '2030-05-01', 'HALF_UP'],
    ['0.25', 'STANDARD', '2030-05-01', 'HALF_UP'],
    ['0.25', 'STANDARD', '2030-05-01', 'HALF_EVEN'],
    ['33.33', 'STANDARD', '2030-05-01', 'HALF_UP'],
    ['100.00', 'STANDARD', '2030-06-30', 'HALF_UP'],
    ['100.00', 'STANDARD', '2030-07-01', 'HALF_UP'],
    ['0.01', 'STANDARD', '2030-05-01', 'UP'],
    ['99999999.99', 'STANDARD', '2030-05-01', 'HALF_UP'],
    ['-0.25', 'STANDARD', '2030-05-01', 'HALF_UP'],
    ['12.34', 'REDUCED', '2030-05-01', 'HALF_UP'],
    ['500.00', 'ZERO', '2030-05-01', 'HALF_UP'],
    ['500.00', 'EXEMPT', '2030-05-01', 'HALF_UP'],
  ];
  const specs: Array<[string, string, string, Mode]> = [...hand];
  for (let i = 0; i < 260; i++) {
    const cents =
      (BigInt(rng.int(0, 99_999_999)) * BigInt(rng.int(1, 100))) / 7n + BigInt(rng.int(0, 99));
    const neg = rng.chance(0.08);
    const date = rng.chance(0.35)
      ? rng.pick(BOUNDARY_DATES)
      : addDays('2028-01-01', rng.int(0, 1800));
    specs.push([
      centsStr(neg ? -cents : cents),
      rng.pick(CODES),
      date,
      rng.chance(0.7) ? 'HALF_UP' : rng.pick(MODES),
    ]);
  }

  specs.forEach(([net, code, date, mode], i) => {
    const r = rateOn(code, date);
    const n = parseCents(net);
    const v = r.taxable ? vatOf(n, r.bp, mode) : 0n;
    calc.push({
      id: `calc-${String(i + 1).padStart(3, '0')}`,
      input: { net, rateCode: code, date, rounding: { mode, scale: 2, level: 'line' } },
      expected: {
        rateId: r.id,
        treatment: r.treatment,
        net: centsStr(n),
        vat: centsStr(v),
        gross: centsStr(n + v),
      },
    });
  });

  specs.forEach(([amount, code, date, mode], i) => {
    const r = rateOn(code, date);
    const g = parseCents(amount);
    const v = r.taxable ? vatFromGross(g, r.bp, mode) : 0n;
    rev.push({
      id: `rev-${String(i + 1).padStart(3, '0')}`,
      input: { gross: amount, rateCode: code, date, rounding: { mode, scale: 2, level: 'line' } },
      expected: {
        rateId: r.id,
        treatment: r.treatment,
        gross: centsStr(g),
        vat: centsStr(v),
        net: centsStr(g - v),
      },
    });
  });
  return { calc, rev };
}

// ----------------------------------------------------------------- invoices
const COMPANIES = [
  'Xəzər Logistika MMC',
  'Bakı Tikinti ASC',
  'Şəfəq Ticarət QSC',
  'Qafqaz Texnologiya MMC',
  'Abşeron Qida MMC',
  'Gəncə Tekstil MMC',
  'Sumqayıt Kimya ASC',
  'Lənkəran Aqro MMC',
  'Mingəçevir Enerji QSC',
  'Şəki İpək MMC',
  'Naxçıvan Mebel MMC',
  'Quba Meyvə MMC',
  'Şirvan Kabel ASC',
  'Kür Nəqliyyat MMC',
  'Muğan Taxıl MMC',
];
const ITEMS: Array<[string, string]> = [
  ['Ofis ləvazimatları', 'STANDARD'],
  ['Nəqliyyat xidməti', 'STANDARD'],
  ['Proqram təminatı lisenziyası', 'STANDARD'],
  ['İxrac malları', 'ZERO'],
  ['Sığorta xidməti', 'EXEMPT'],
  ['Qida məhsulları', 'REDUCED'],
  ['Tikinti materialı', 'STANDARD'],
  ['Konsaltinq xidməti', 'STANDARD'],
  ['Avadanlıq icarəsi', 'STANDARD'],
  ['Təmir işləri', 'STANDARD'],
];
const MAPPING = {
  receivable: '211',
  payable: '521',
  revenue: '601',
  expense: '731',
  vatOutput: '533',
  vatInput: '241',
};

function invoiceCases() {
  const rng = makeRng(20301002);
  const invoices: unknown[] = [];
  const checks: unknown[] = [];
  const numberOf = (i: number) =>
    `${rng.pick(['AA', 'AB', 'BX', 'QM'])} ${String(1_000_000 + i * 37 + rng.int(0, 30)).padStart(7, '0')}`;
  const voen = () => `${rng.int(1_000_000_00, 9_999_999_99)}${rng.pick([1, 2])}`.slice(0, 10);

  for (let i = 0; i < 220; i++) {
    const direction = rng.chance(0.5) ? 'sales' : 'purchase';
    const date = rng.chance(0.3)
      ? rng.pick(BOUNDARY_DATES)
      : addDays('2029-06-01', rng.int(0, 900));
    const level = rng.chance(0.5) ? 'line' : 'total';
    const mode: Mode = rng.chance(0.75) ? 'HALF_UP' : rng.pick(MODES);
    const lineCount = rng.int(1, 8);
    const lines = Array.from({ length: lineCount }, () => {
      const [description, code] = rng.pick(ITEMS);
      const qty = rng.chance(0.5)
        ? String(rng.int(1, 50))
        : `${rng.int(0, 99)}.${String(rng.int(1, 999)).padStart(3, '0')}`;
      const unitPrice = `${rng.int(1, 5000)}.${String(rng.int(0, 9999)).padStart(4, '0')}`;
      return { description, qty, unitPrice, vatRateCode: code };
    });
    const ref: RefLine[] = lines.map((l) => {
      const r = rateOn(l.vatRateCode, date);
      return {
        qty: l.qty,
        unitPrice: l.unitPrice,
        rateBp: r.bp,
        taxable: r.taxable,
        code: l.vatRateCode,
      };
    });
    const t = refTotals(ref, level, mode);

    // Jurnal gözləntisi (hesab üzrə cəmlər) — yalnız müsbət yekun məbləğlər üçün
    const gross = t.net + t.vat;
    const acct: Record<string, { debit: string; credit: string }> = {};
    const put = (code: string, debit: bigint, credit: bigint) => {
      if (debit === 0n && credit === 0n) return;
      const cur = acct[code] ?? { debit: '0.00', credit: '0.00' };
      acct[code] = {
        debit: centsStr(parseCents(cur.debit) + debit),
        credit: centsStr(parseCents(cur.credit) + credit),
      };
    };
    if (direction === 'sales') {
      put(MAPPING.receivable, gross, 0n);
      put(MAPPING.revenue, 0n, t.net);
      put(MAPPING.vatOutput, 0n, t.vat);
    } else {
      put(MAPPING.expense, t.net, 0n);
      put(MAPPING.vatInput, t.vat, 0n);
      put(MAPPING.payable, 0n, gross);
    }

    const counterparty = { name: rng.pick(COMPANIES), voen: voen() };
    const base = {
      direction,
      number: numberOf(i),
      issueDate: date,
      counterparty,
      lines,
    };
    invoices.push({
      id: `inv-${String(i + 1).padStart(3, '0')}`,
      ...base,
      rounding: { mode, scale: 2, level },
      expected: {
        lineNets: t.lines.map((l) => centsStr(l.net)),
        // sətir səviyyəsində hər sətrin ƏDV-si dəqiq bilinir; cəm səviyyəsində bölgü mühərrik qərarıdır
        ...(level === 'line' ? { lineVats: t.lines.map((l) => centsStr(l.vat)) } : {}),
        net: centsStr(t.net),
        vat: centsStr(t.vat),
        gross: centsStr(gross),
        byRate: Object.fromEntries(
          Object.entries(t.byRate).map(([k, v]) => [
            k,
            { net: centsStr(v.net), ...(level === 'line' ? { vat: centsStr(v.vat) } : {}) },
          ]),
        ),
        journalTotals: acct,
      },
    });

    // ---- invoice.check: sətir səviyyəsində hesablanmış başlıq + (bəzilərində) qəsdən xəta
    const lineT = refTotals(ref, 'line', 'HALF_UP');
    const headerNet = lineT.net;
    const headerVat = lineT.vat;
    const checkLines = lines.map((l, k) => ({
      description: l.description,
      qty: l.qty,
      unitPrice: l.unitPrice,
      vatRateCode: l.vatRateCode,
      net: centsStr(lineT.lines[k]!.net),
      vat: centsStr(lineT.lines[k]!.vat),
    }));
    const doc = {
      direction,
      number: base.number,
      issueDate: date,
      counterparty: { voen: counterparty.voen, isVatPayer: true },
      currency: 'AZN',
      net: centsStr(headerNet),
      vat: centsStr(headerVat),
      gross: centsStr(headerNet + headerVat),
      lines: checkLines,
    };
    const defect = rng.pick([
      'none',
      'none',
      'none',
      'vat_tamper',
      'wrong_rate',
      'header_gross',
      'header_net',
      'qty_price',
      'bad_voen',
      'unknown_rate',
      'duplicate',
      'bad_date',
    ] as const);
    const mutated: typeof doc = JSON.parse(JSON.stringify(doc));
    let expectedCodes: string[] = [];
    const existing: unknown[] = [];
    const k = rng.int(0, lines.length - 1);
    const money = (s: string, delta: bigint) => centsStr(parseCents(s) + delta);

    switch (defect) {
      case 'vat_tamper': {
        mutated.lines[k]!.vat = money(mutated.lines[k]!.vat, 100n);
        mutated.vat = money(mutated.vat, 100n);
        mutated.gross = money(mutated.gross, 100n);
        expectedCodes = ['VAT_RATE_MISMATCH'];
        break;
      }
      case 'wrong_rate': {
        // taxable sətri ZERO kodu ilə göstərib ƏDV tutulub → bəyan olunan kod ilə məbləğ uyğun deyil
        const idx = ref.findIndex((r) => r.taxable && lineT.lines[ref.indexOf(r)]!.vat >= 100n);
        if (idx === -1) {
          expectedCodes = [];
        } else {
          mutated.lines[idx]!.vatRateCode = 'ZERO';
          expectedCodes = ['VAT_RATE_MISMATCH'];
        }
        break;
      }
      case 'header_gross':
        mutated.gross = money(mutated.gross, 500n);
        expectedCodes = ['TOTAL_MISMATCH'];
        break;
      case 'header_net':
        mutated.net = money(mutated.net, 500n);
        mutated.gross = money(mutated.gross, 500n);
        expectedCodes = ['TOTAL_MISMATCH'];
        break;
      case 'qty_price': {
        mutated.lines[k]!.qty = String(BigInt(Math.trunc(Number(lines[k]!.qty)) + 7));
        // qty dəyişdi, net eyni qaldı: yeni qty×qiymət fərqi 1 qəpikdən çox olmalıdır
        const nn = lineNetCents(mutated.lines[k]!.qty, lines[k]!.unitPrice, 'HALF_UP');
        const diff = nn - lineT.lines[k]!.net;
        expectedCodes = diff > 1n || diff < -1n ? ['LINE_NET_MISMATCH'] : [];
        break;
      }
      case 'bad_voen':
        mutated.counterparty.voen = '12345';
        expectedCodes = ['INVALID_TAX_ID'];
        break;
      case 'unknown_rate':
        mutated.lines[k]!.vatRateCode = 'NOPE';
        expectedCodes = ['RATE_NOT_FOUND'];
        break;
      case 'duplicate':
        existing.push({
          id: `old-${i}`,
          direction,
          number: base.number.toLowerCase(),
          counterpartyVoen: counterparty.voen,
        });
        expectedCodes = ['DUPLICATE_INVOICE'];
        break;
      case 'bad_date':
        mutated.issueDate = '2030-02-30';
        expectedCodes = ['INVALID_DATE'];
        break;
      case 'none':
        break;
    }
    checks.push({
      id: `chk-${String(i + 1).padStart(3, '0')}`,
      defect,
      invoice: mutated,
      existing,
      expectedIssueCodes: [...expectedCodes].sort(),
    });
  }
  return { invoices, checks };
}

export function buildGolden() {
  const { calc, rev } = vatCases();
  const { invoices, checks } = invoiceCases();
  return {
    'rates.json': { description: 'TEST FIXTURE rate table (not real legislation).', rates: RATES },
    'vat-calculate.json': {
      description: 'vat.calculate — expected values from the independent BigInt reference.',
      cases: calc,
    },
    'vat-reverse.json': {
      description: 'vat.reverse — expected values from the independent BigInt reference.',
      cases: rev,
    },
    'invoices.json': {
      description: 'Invoice totals + proposed journal; anonymised fictional parties.',
      mapping: MAPPING,
      cases: invoices,
    },
    'invoice-check.json': {
      description: 'invoice.check with injected defects and their expected issue codes.',
      cases: checks,
    },
  } as const;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  await mkdir(dir, { recursive: true });
  const files = buildGolden();
  for (const [name, content] of Object.entries(files)) {
    await writeFile(`${dir}${name}`, JSON.stringify(content, null, 2) + '\n');
  }
  console.log(`golden files written to ${dir}: ${Object.keys(files).join(', ')}`);
}
