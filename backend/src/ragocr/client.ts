import { z } from 'zod';
import { UpstreamError } from '../rag/clients.js';
import { ModelResponseError, type ModelServing, type OcrResult } from '../models/client.js';

const Passage = z
  .object({
    id: z.string(),
    article: z.union([z.string(), z.number()]),
    title: z.string(),
    text: z.string(),
    source_url: z.string().nullable().optional(),
    effective_from: z.string().nullable().optional(),
    validity_verified: z.boolean().optional(),
  })
  .passthrough();
export type RegulationPassage = z.infer<typeof Passage>;

const Fields = z
  .object({
    raw_text: z.string().default(''),
    document_type: z.string().nullable().optional(),
    supplier: z.string().nullable().optional(),
    supplier_voen: z.string().nullable().optional(),
    receipt_number: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    subtotal: z.string().nullable().optional(),
    vat_amount: z.string().nullable().optional(),
    total_amount: z.string().nullable().optional(),
    line_items: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .passthrough();
const Validation = z.object({ issues: z.array(z.unknown()).default([]) }).passthrough();
const DocRecord = z
  .object({
    document_id: z.uuid(),
    company_id: z.string().optional(),
    original_filename: z.string().optional(),
    review_status: z.string(),
    fields: Fields,
    validation: Validation.optional(),
  })
  .passthrough();
export type ReceiptRecord = z.infer<typeof DocRecord>;
const DocCandidate = z
  .object({
    document_id: z.uuid(),
    score: z.number(),
    review_status: z.string(),
    fields: Fields,
    validation: Validation.optional(),
  })
  .passthrough();

export interface RagOcrClient {
  searchRegulations(question: string, topK: number): Promise<RegulationPassage[]>;
  searchDocuments(req: {
    companyId: string;
    query: string;
    topK: number;
    date?: string | undefined;
    supplier?: string | undefined;
  }): Promise<Array<z.infer<typeof DocCandidate>>>;
  getDocument(companyId: string, documentId: string): Promise<ReceiptRecord | null>;
  ingestDocument(
    companyId: string,
    file: Buffer,
    name: string,
    mime: string,
  ): Promise<ReceiptRecord>;
  ocr(file: Buffer, mime: string): Promise<OcrResult>;
}

/** python sidecar-ın (`modules/lexaudit_rag/service.py`) HTTP müştərisi. companyId həmişə sessiyadan gəlir. */
export class HttpRagOcr implements RagOcrClient {
  constructor(
    private readonly o: {
      baseUrl: string;
      token: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private async call<T>(path: string, init: RequestInit, schema: z.ZodType<T>, allow404 = false) {
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(new URL(path, this.o.baseUrl), {
        ...init,
        headers: { authorization: `Bearer ${this.o.token}`, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 120_000),
      });
    } catch (e) {
      throw new UpstreamError(`rag-ocr unreachable: ${(e as Error).message}`, { cause: e });
    }
    if (allow404 && res.status === 404) return null;
    // 4xx: sorğu/sənəd problemi (təkrar cəhd mənasızdır); 5xx/401/503: keçici/konfiqurasiya
    if (res.status === 422 || res.status === 413) {
      const d = (await res.json().catch(() => ({}))) as { detail?: unknown };
      throw new ModelResponseError(
        `rag-ocr ${path} rejected the input: ${JSON.stringify(d.detail)}`,
      );
    }
    if (!res.ok) throw new UpstreamError(`rag-ocr ${path} returned HTTP ${res.status}`);
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success)
      throw new ModelResponseError(
        `rag-ocr ${path} response does not match the contract: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    return parsed.data;
  }
  private json(body: unknown): RequestInit {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }
  private form(
    file: Buffer,
    name: string,
    mime: string,
    extra: Record<string, string> = {},
  ): RequestInit {
    const f = new FormData();
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    f.set('file', new Blob([new Uint8Array(file)], { type: mime }), name);
    return { method: 'POST', body: f };
  }

  async searchRegulations(question: string, topK: number) {
    const r = await this.call(
      '/v1/regulations/search',
      this.json({ question, topK }),
      z.object({ results: z.array(Passage) }),
    );
    return r!.results;
  }
  async searchDocuments(req: Parameters<RagOcrClient['searchDocuments']>[0]) {
    const r = await this.call(
      '/v1/documents/search',
      this.json({
        companyId: req.companyId,
        query: req.query,
        topK: req.topK,
        date: req.date ?? null,
        supplier: req.supplier ?? null,
      }),
      z.object({ results: z.array(DocCandidate) }),
    );
    return r!.results;
  }
  getDocument(companyId: string, documentId: string) {
    const q = new URLSearchParams({ companyId });
    return this.call(
      `/v1/documents/${encodeURIComponent(documentId)}?${q}`,
      { method: 'GET' },
      DocRecord,
      true,
    );
  }
  async ingestDocument(companyId: string, file: Buffer, name: string, mime: string) {
    return (await this.call(
      '/v1/documents/ingest',
      this.form(file, name, mime, { companyId }),
      DocRecord,
    ))!;
  }
  async ocr(file: Buffer, mime: string): Promise<OcrResult> {
    const r = (await this.call(
      '/v1/ocr',
      this.form(file, 'upload', mime),
      z.object({ text: z.string().min(1), model: z.string().min(1) }),
    ))!;
    return { text: r.text, model: r.model };
  }
}

/** OCR-ı sidecar-a yönləndirir; model-serving varsa qalan metodlar ondan qalır. */
export function withRagOcr(base: ModelServing | undefined, rag: RagOcrClient): ModelServing {
  const unavailable = (what: string) => () =>
    Promise.reject(
      new UpstreamError(
        `${what} needs MODEL_SERVING_BASE_URL pointing to a compatible model server; ` +
          'the RAG/OCR sidecar only provides OCR and search (see SETUP.md)',
      ),
    );
  return {
    // Class methods live on the prototype: spreading a client drops them and its `this` binding.
    extractInvoice: base ? (text) => base.extractInvoice(text) : unavailable('invoice extraction'),
    classifyNews: base ? (text) => base.classifyNews(text) : unavailable('news classification'),
    classifyAccount: base
      ? (req) => base.classifyAccount(req)
      : unavailable('account classification'),
    ...(base?.listModels ? { listModels: base.listModels.bind(base) } : {}),
    ocr: (file, mime) => rag.ocr(file, mime),
  };
}
