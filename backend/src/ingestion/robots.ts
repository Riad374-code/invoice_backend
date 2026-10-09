export interface RobotsRules {
  allows(path: string): boolean;
  crawlDelaySeconds: number | null;
}

/** robots.txt: bizim UA qrupu, yoxsa `*`. Ən uzun uyğun qayda qalib gəlir; bərabərlikdə Allow. */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const ua = userAgent.toLowerCase();
  const groups: Array<{
    agents: string[];
    rules: Array<{ allow: boolean; path: string }>;
    delay: number | null;
  }> = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow')
      current.rules.push({ allow: key === 'allow', path: value });
    else if (key === 'crawl-delay')
      current.delay = /^\d+(\.\d+)?$/.test(value) ? Math.ceil(Number(value)) : null;
  }
  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const group = specific ?? groups.find((g) => g.agents.includes('*')) ?? null;
  const rules = group?.rules ?? [];

  const toRegex = (p: string) =>
    new RegExp(
      '^' +
        p
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\\\$$/, '$'),
    );
  return {
    crawlDelaySeconds: group?.delay ?? null,
    allows(path: string) {
      let best: { allow: boolean; len: number } | null = null;
      for (const r of rules) {
        if (r.path === '') continue; // "Disallow:" boşdur = hər şey icazəlidir
        if (toRegex(r.path).test(path)) {
          const len = r.path.length;
          if (!best || len > best.len || (len === best.len && r.allow))
            best = { allow: r.allow, len };
        }
      }
      return best ? best.allow : true;
    },
  };
}
