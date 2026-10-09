import type { ChunkHit, ResourceType } from '../db/repos/chunks.js';
import type { Repos } from '../db/index.js';
import { buildContext, NO_SOURCE_MESSAGE, type SourceHit } from './citations.js';
import { toVectorLiteral, type Embedder, type Reranker, UpstreamError } from './clients.js';
import { detectLanguage, type Lang } from './lang.js';
import { buildPrefixQuery } from './query.js';
import { reciprocalRankFusion } from './rrf.js';

export interface SearchDeps {
  repos: Repos;
  embedder?: Embedder | undefined;
  reranker?: Reranker | undefined;
  log?: { warn(o: object, m: string): void };
}

export interface SearchRequest {
  query: string;
  companyId: string;
  resourceTypes: readonly ResourceType[];
  /** Tarix filtri: qanun həmin gün qüvvədə olan versiya ilə axtarılır. */
  date: string;
  jurisdiction?: string;
  topK?: number;
  candidates?: number;
  /** Vektor nəticələri üçün minimum cosine oxşarlığı (default 0.3; modelə görə tənzimlənməlidir). */
  minSimilarity?: number;
  /** Sorğunu yenidən yazan (LLM, B9); verilməsə sorğu olduğu kimi. */
  rewrite?: (q: string, lang: Lang) => Promise<string>;
}

export interface SearchResult {
  query: string;
  effectiveQuery: string;
  language: Lang;
  /** Hansı axtarış yolları işlədi (embedding əlçatmazdırsa yalnız fulltext — açıq göstərilir) */
  modes: Array<'vector' | 'fulltext'>;
  reranked: boolean;
  hits: Array<
    SourceHit & {
      chunkId: string;
      resourceType: ResourceType;
      resourceId: string;
      url: string | null;
      scores: { rrf: number; rerank: number | null };
    }
  >;
  message: string | null;
}

export async function hybridSearch(deps: SearchDeps, req: SearchRequest): Promise<SearchResult> {
  const topK = req.topK ?? 8;
  const candidates = req.candidates ?? 50;
  const language = detectLanguage(req.query);
  let effective = req.query;
  if (req.rewrite) {
    try {
      effective = (await req.rewrite(req.query, language)).trim() || req.query;
    } catch (e) {
      deps.log?.warn({ err: String(e) }, 'query rewrite failed, using original query');
    }
  }

  const filter = {
    companyId: req.companyId,
    resourceTypes: req.resourceTypes,
    date: req.date,
    jurisdiction: req.jurisdiction ?? 'AZ',
    limit: candidates,
    minSimilarity: req.minSimilarity ?? 0.3,
  };
  const modes: SearchResult['modes'] = [];

  const vectorTask = async (): Promise<ChunkHit[]> => {
    if (!deps.embedder) return [];
    try {
      const [vec] = await deps.embedder.embed([effective]);
      if (!vec) return [];
      const hits = await deps.repos.chunks.vectorSearch(
        toVectorLiteral(vec),
        deps.embedder.model,
        filter,
      );
      modes.push('vector');
      return hits;
    } catch (e) {
      if (!(e instanceof UpstreamError)) throw e;
      deps.log?.warn(
        { err: e.message },
        'vector search unavailable, falling back to full-text only',
      );
      return [];
    }
  };
  const [vectorHits, textHits] = await Promise.all([
    vectorTask(),
    deps.repos.chunks.fullTextSearch(buildPrefixQuery(effective), filter).then((h) => {
      modes.push('fulltext');
      return h;
    }),
  ]);

  const fused = reciprocalRankFusion({ vector: vectorHits, fulltext: textHits });
  if (fused.length === 0) {
    return {
      query: req.query,
      effectiveQuery: effective,
      language,
      modes: modes.sort(),
      reranked: false,
      hits: [],
      message: NO_SOURCE_MESSAGE,
    };
  }

  // Rerank (model-serving) → top K; əlçatmazdırsa RRF sırası saxlanılır və bu açıq bildirilir
  let ordered = fused.slice(0, Math.max(topK * 3, topK));
  let reranked = false;
  const rerankScores = new Map<string, number>();
  if (deps.reranker) {
    try {
      const scores = await deps.reranker.rerank(
        effective,
        ordered.map((f) => f.item.text),
      );
      ordered = ordered
        .map((f, i) => ({ f, s: scores[i] ?? Number.NEGATIVE_INFINITY }))
        .sort((a, b) => b.s - a.s || (a.f.item.id < b.f.item.id ? -1 : 1))
        .map((x) => {
          rerankScores.set(x.f.item.id, x.s);
          return x.f;
        });
      reranked = true;
    } catch (e) {
      if (!(e instanceof UpstreamError)) throw e;
      deps.log?.warn({ err: e.message }, 'rerank unavailable, keeping RRF order');
    }
  }
  const top = ordered.slice(0, topK);
  const { hits: labelled } = buildContext(
    top.map((f) => ({
      id: f.item.id,
      text: f.item.text,
      sourceTitle: f.item.title,
      articleRef: f.item.articleRef,
      versionNo: f.item.versionNo,
    })),
  );
  return {
    query: req.query,
    effectiveQuery: effective,
    language,
    modes: modes.sort(),
    reranked,
    hits: labelled.map((h, i) => {
      const f = top[i]!;
      return {
        ...h,
        chunkId: h.id,
        resourceType: f.item.resourceType,
        resourceId: f.item.resourceId,
        url: f.item.url,
        scores: { rrf: f.score, rerank: rerankScores.get(f.item.id) ?? null },
      };
    }),
    message: null,
  };
}
