import { diffLines } from 'diff';

export interface DiffHunk {
  type: 'added' | 'removed' | 'unchanged';
  text: string;
}

const withNl = (s: string) => (s.endsWith('\n') ? s : `${s}\n`);

/** Abzas səviyyəsində fərq (qanun versiyaları arasında). */
export function diffText(from: string, to: string): DiffHunk[] {
  return diffLines(withNl(from), withNl(to), { newlineIsToken: false }).map((p) => ({
    type: p.added ? 'added' : p.removed ? 'removed' : 'unchanged',
    text: p.value.replace(/\n+$/, ''),
  }));
}
