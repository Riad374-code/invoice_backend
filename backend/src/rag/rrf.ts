export interface Ranked {
  id: string;
}

export interface Fused<T extends Ranked> {
  item: T;
  score: number;
  /** Hər siyahıdakı yeri (1-based) — sübut/debug üçün */
  ranks: Record<string, number>;
}

/**
 * Reciprocal Rank Fusion: score(d) = Σ 1 / (k + rank_i(d)). Siyahı miqyaslarından (cosine vs ts_rank) asılı deyil.
 * Bərabərlikdə id-yə görə sabit sıra (deterministik).
 */
export function reciprocalRankFusion<T extends Ranked>(
  lists: Record<string, readonly T[]>,
  k = 60,
): Array<Fused<T>> {
  const acc = new Map<string, Fused<T>>();
  for (const [name, list] of Object.entries(lists)) {
    list.forEach((item, i) => {
      const cur = acc.get(item.id) ?? { item, score: 0, ranks: {} };
      if (cur.ranks[name] === undefined) {
        cur.score += 1 / (k + i + 1);
        cur.ranks[name] = i + 1;
      }
      acc.set(item.id, cur);
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : 1));
}
