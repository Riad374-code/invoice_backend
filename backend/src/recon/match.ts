import { D, type Dec } from '../accounting/index.js';
import { daysBetween } from '../accounting/dates.js';

export interface ReconItem {
  /** mənbədə sətrin yeri/id-si */
  ref: string;
  key: string;
  amount: Dec;
  date: string | null;
}
export type MatchType =
  'exact' | 'amount_mismatch' | 'amount_date' | 'unmatched_left' | 'unmatched_right';
export interface ReconMatch {
  type: MatchType;
  confidence: Dec;
  left: ReconItem | null;
  right: ReconItem | null;
  difference: Dec | null;
  explanation: string;
}

export const normKey = (s: string): string => s.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Deterministik uzlaşdırma (AI yoxdur). Hər element ən çoxu bir cütdə:
 *  1) eyni açar + eyni məbləğ → exact (1.0)
 *  2) eyni açar, fərqli məbləğ → amount_mismatch (0.7; insan yoxlamalıdır)
 *  3) açarsız/uyğunsuz: eyni məbləğ + tarix pəncərəsi + hər iki tərəfdən TƏK namizəd → amount_date (0.8)
 *  4) qalanlar unmatched. Birdən çox eyni yaxşı namizəd varsa təxmin edilmir.
 */
export function reconcileItems(
  left: readonly ReconItem[],
  right: readonly ReconItem[],
  opts: { dateWindowDays?: number } = {},
): ReconMatch[] {
  const window = opts.dateWindowDays ?? 3;
  const usedL = new Set<number>();
  const usedR = new Set<number>();
  const out: ReconMatch[] = [];
  const link = (li: number, ri: number, type: MatchType, conf: string, why: string) => {
    usedL.add(li);
    usedR.add(ri);
    out.push({
      type,
      confidence: new D(conf),
      left: left[li]!,
      right: right[ri]!,
      difference: left[li]!.amount.minus(right[ri]!.amount),
      explanation: why,
    });
  };

  left.forEach((l, li) => {
    if (!l.key) return;
    const ri = right.findIndex((r, i) => !usedR.has(i) && r.key === l.key && r.amount.eq(l.amount));
    if (ri !== -1)
      link(li, ri, 'exact', '1', `Key ${l.key} and amount ${l.amount.toFixed(2)} are identical`);
  });
  left.forEach((l, li) => {
    if (usedL.has(li) || !l.key) return;
    const ri = right.findIndex((r, i) => !usedR.has(i) && r.key === l.key);
    if (ri !== -1)
      link(
        li,
        ri,
        'amount_mismatch',
        '0.7',
        `Key ${l.key} matches but amounts differ: ${l.amount.toFixed(2)} vs ${right[ri]!.amount.toFixed(2)}`,
      );
  });
  left.forEach((l, li) => {
    if (usedL.has(li) || !l.date) return;
    const near = (r: ReconItem) =>
      r.date !== null && r.amount.eq(l.amount) && Math.abs(daysBetween(l.date!, r.date)) <= window;
    const rc = right.map((r, i) => i).filter((i) => !usedR.has(i) && near(right[i]!));
    if (rc.length !== 1) return;
    const ri = rc[0]!;
    const rd = right[ri]!.date;
    const back = left
      .map((_, i) => i)
      .filter((i) => {
        const x = left[i]!;
        return (
          !usedL.has(i) &&
          rd !== null &&
          x.date !== null &&
          x.amount.eq(right[ri]!.amount) &&
          Math.abs(daysBetween(x.date, rd)) <= window
        );
      });
    if (back.length === 1)
      link(
        li,
        ri,
        'amount_date',
        '0.8',
        `Same amount ${l.amount.toFixed(2)} within ${window} day(s) (${l.date} ↔ ${right[ri]!.date})`,
      );
  });
  left.forEach((l, li) => {
    if (!usedL.has(li))
      out.push({
        type: 'unmatched_left',
        confidence: new D(0),
        left: l,
        right: null,
        difference: l.amount,
        explanation: `Only on the left: ${l.key || l.ref} ${l.amount.toFixed(2)}`,
      });
  });
  right.forEach((r, ri) => {
    if (!usedR.has(ri))
      out.push({
        type: 'unmatched_right',
        confidence: new D(0),
        left: null,
        right: r,
        difference: r.amount.negated(),
        explanation: `Only on the right: ${r.key || r.ref} ${r.amount.toFixed(2)}`,
      });
  });
  return out;
}
