/**
 * MÜSTƏQİL İCRA: mühasibat mühərrikindən (decimal.js) tamamilə ayrı, BigInt-əsaslı qəpik hesabı.
 * Golden fayllardakı "gözlənilən" dəyərlər BURADAN gəlir — mühərrik öz-özünü yoxlamasın deyə.
 * Burada heç bir src/ importu YOXDUR.
 */
export type Mode = 'HALF_UP' | 'HALF_EVEN' | 'UP' | 'DOWN';

const abs = (n: bigint) => (n < 0n ? -n : n);
const sign = (n: bigint) => (n < 0n ? -1n : 1n);

/** n / d (d > 0), verilmiş rejimdə tam ədədə yuvarlaqlaşdırılır. */
export function divRound(n: bigint, d: bigint, mode: Mode): bigint {
  const q = n / d; // sıfıra doğru kəsir
  const r = n % d;
  if (r === 0n) return q;
  const away = q + sign(n);
  switch (mode) {
    case 'DOWN':
      return q;
    case 'UP':
      return away;
    case 'HALF_UP':
      return 2n * abs(r) >= d ? away : q;
    case 'HALF_EVEN': {
      const twice = 2n * abs(r);
      if (twice > d) return away;
      if (twice < d) return q;
      return q % 2n === 0n ? q : away;
    }
  }
}

/** "123.45" / "-0.5" → 12345n / -50n (iki onluqdan çox olmamalıdır). */
export function parseCents(s: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`bad money ${s}`);
  const v = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] ? -v : v;
}

export function fmtCents(c: bigint): string {
  const a = abs(c);
  return `${c < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

/** Faiz → baza bəndləri: "18" → 1800n, "4.5" → 450n. */
export function bp(percent: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(percent);
  if (!m) throw new Error(`bad percent ${percent}`);
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
}

export const vatOf = (netCents: bigint, rateBp: bigint, mode: Mode): bigint =>
  divRound(netCents * rateBp, 10_000n, mode);

/** ƏDV daxil məbləğdən ƏDV: gross × r / (100 + r). */
export const vatFromGross = (grossCents: bigint, rateBp: bigint, mode: Mode): bigint =>
  divRound(grossCents * rateBp, 10_000n + rateBp, mode);

/** qty (≤3 onluq) × qiymət (≤4 onluq) → qəpik. */
export function lineNetCents(qty: string, unitPrice: string, mode: Mode): bigint {
  const parse = (s: string, scale: number) => {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m || (m[2] ?? '').length > scale) throw new Error(`bad number ${s}`);
    return BigInt(m[1]! + (m[2] ?? '').padEnd(scale, '0'));
  };
  const product = parse(qty, 3) * parse(unitPrice, 4); // ölçü 1e-7
  return divRound(product * 100n, 10_000_000n, mode); // → qəpik
}

export interface RefLine {
  qty: string;
  unitPrice: string;
  rateBp: bigint;
  taxable: boolean;
  code: string;
}

export interface RefTotals {
  lines: Array<{ net: bigint; vat: bigint }>;
  net: bigint;
  vat: bigint;
  byRate: Record<string, { net: bigint; vat: bigint }>;
}

export function refTotals(lines: RefLine[], level: 'line' | 'total', mode: Mode): RefTotals {
  const nets = lines.map((l) => lineNetCents(l.qty, l.unitPrice, mode));
  const vats = lines.map((l, i) => (l.taxable ? vatOf(nets[i]!, l.rateBp, mode) : 0n));
  let totalVat = vats.reduce((a, b) => a + b, 0n);
  if (level === 'total') {
    // Dəqiq cəm bir dəfə yuvarlaqlaşdırılır (sətirlər arası bölgü yalnız sətir sətirdir, cəmə təsir etmir)
    const exactTimes10k = lines.reduce((a, l, i) => (l.taxable ? a + nets[i]! * l.rateBp : a), 0n);
    totalVat = divRound(exactTimes10k, 10_000n, mode);
  }
  const byRate: RefTotals['byRate'] = {};
  lines.forEach((l, i) => {
    const slot = (byRate[l.code] ??= { net: 0n, vat: 0n });
    slot.net += nets[i]!;
    slot.vat += vats[i]!;
  });
  return {
    lines: nets.map((net, i) => ({ net, vat: vats[i]! })),
    net: nets.reduce((a, b) => a + b, 0n),
    vat: totalVat,
    byRate,
  };
}
