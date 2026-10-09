export const EMBEDDING_DIM = 1024;

export class UpstreamError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UpstreamError';
  }
}

export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}
export interface Reranker {
  /** @returns hər sənəd üçün uyğunluq balı (giriş sırası ilə) */
  rerank(query: string, documents: string[]): Promise<number[]>;
}

interface HttpOpts {
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function post<T>(o: HttpOpts, path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(new URL(path, o.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw new UpstreamError(`model-serving unreachable: ${(e as Error).message}`, { cause: e });
  }
  if (!res.ok) throw new UpstreamError(`model-serving ${path} returned HTTP ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch (e) {
    throw new UpstreamError(`model-serving ${path} returned invalid JSON`, { cause: e });
  }
}

/** OpenAI-uyğun `POST /v1/embeddings`. Cavabın ölçüsü və sırası ciddi yoxlanılır. */
export class HttpEmbedder implements Embedder {
  constructor(
    private readonly o: HttpOpts,
    readonly model: string,
  ) {}
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await post<{ data?: Array<{ index?: number; embedding?: number[] }> }>(
      this.o,
      '/v1/embeddings',
      { model: this.model, input: texts },
    );
    const data = res.data;
    if (!Array.isArray(data) || data.length !== texts.length)
      throw new UpstreamError('Embedding count does not match input count');
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((d, i) => {
      if (
        !Array.isArray(d.embedding) ||
        d.embedding.length !== EMBEDDING_DIM ||
        d.embedding.some((x) => typeof x !== 'number' || !Number.isFinite(x))
      ) {
        throw new UpstreamError(
          `Embedding ${i} is not a finite ${EMBEDDING_DIM}-dimensional vector`,
        );
      }
      return d.embedding;
    });
  }
}

/** `POST /v1/rerank` → [{index, relevance_score}] */
export class HttpReranker implements Reranker {
  constructor(
    private readonly o: HttpOpts,
    private readonly model: string,
  ) {}
  async rerank(query: string, documents: string[]): Promise<number[]> {
    if (documents.length === 0) return [];
    const res = await post<{ results?: Array<{ index?: number; relevance_score?: number }> }>(
      this.o,
      '/v1/rerank',
      { model: this.model, query, documents, top_n: documents.length },
    );
    const scores = new Array<number>(documents.length).fill(Number.NEGATIVE_INFINITY);
    for (const r of res.results ?? []) {
      if (
        typeof r.index === 'number' &&
        r.index >= 0 &&
        r.index < documents.length &&
        typeof r.relevance_score === 'number'
      )
        scores[r.index] = r.relevance_score;
    }
    return scores;
  }
}

/** pgvector literalı: '[0.1,0.2,…]' */
export function toVectorLiteral(v: readonly number[]): string {
  return `[${v.join(',')}]`;
}
