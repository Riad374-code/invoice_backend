import { z } from 'zod';
import { UpstreamError } from '../rag/clients.js';

const Money = z.string().regex(/^-?\d+(\.\d+)?$/);
const Conf = z.number().min(0).max(1);

/** `POST /v1/extract/invoice` cavabının JSON Schema-sı (BACKEND.md §13). Uyğun gəlməyən cavab rədd edilir. */
export const ExtractedInvoiceSchema = z.object({
  invoice: z.object({
    number: z.string().min(1).max(100),
    issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    currency: z.string().length(3).default('AZN'),
    seller: z.object({ name: z.string().min(1), voen: z.string().nullable().optional() }),
    buyer: z.object({ name: z.string().min(1), voen: z.string().nullable().optional() }),
    lines: z
      .array(
        z.object({
          description: z.string().min(1),
          qty: Money,
          unitPrice: Money,
          /** Model ya faiz (məs. "18"), ya da kod verir; server faizi cədvəldən koda çevirir. */
          vatPercent: Money.nullable().optional(),
          vatRateCode: z.string().nullable().optional(),
          net: Money,
          vat: Money,
        }),
      )
      .min(1)
      .max(500),
    net: Money.nullable().optional(),
    vat: Money.nullable().optional(),
    gross: Money.nullable().optional(),
  }),
  /** Sahə yolu → etibarlılıq: "number", "issueDate", "seller.voen", "lines.0.net", … */
  confidence: z.record(z.string(), Conf).default({}),
  overallConfidence: Conf,
  model: z.string().min(1),
});
export type ExtractedInvoice = z.infer<typeof ExtractedInvoiceSchema>;

const OcrSchema = z.object({
  text: z.string(),
  pages: z.number().int().min(0).optional(),
  confidence: Conf.optional(),
  model: z.string().min(1),
});
const AccountSchema = z.object({
  accountCode: z.string().regex(/^\d{3,6}$/),
  confidence: Conf,
  model: z.string().min(1),
  alternatives: z
    .array(z.object({ accountCode: z.string().regex(/^\d{3,6}$/), confidence: Conf }))
    .max(5)
    .default([]),
});
export type OcrResult = z.infer<typeof OcrSchema>;
export type AccountSuggestion = z.infer<typeof AccountSchema>;

export interface ModelServing {
  ocr(file: Buffer, mime: string): Promise<OcrResult>;
  extractInvoice(text: string): Promise<ExtractedInvoice>;
  classifyAccount(req: {
    description: string;
    direction: 'sales' | 'purchase';
    standard: 'MMUS' | 'MHBS';
    candidates?: Array<{ code: string; name: string }>;
  }): Promise<AccountSuggestion>;
}

export class HttpModelServing implements ModelServing {
  constructor(
    private readonly o: {
      baseUrl: string;
      apiKey?: string | undefined;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(new URL(path, this.o.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 120_000),
      });
    } catch (e) {
      throw new UpstreamError(`model-serving unreachable: ${(e as Error).message}`, { cause: e });
    }
    if (!res.ok) throw new UpstreamError(`model-serving ${path} returned HTTP ${res.status}`);
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success)
      throw new ModelResponseError(
        `model-serving ${path} response does not match the contract: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    return parsed.data;
  }

  ocr(file: Buffer, mime: string) {
    return this.post('/v1/ocr', { mime, data: file.toString('base64') }, OcrSchema);
  }
  extractInvoice(text: string) {
    return this.post('/v1/extract/invoice', { text }, ExtractedInvoiceSchema);
  }
  classifyAccount(req: Parameters<ModelServing['classifyAccount']>[0]) {
    return this.post('/v1/classify/account', req, AccountSchema);
  }
}

/** Model cavabı müqaviləyə uyğun deyil — təkrar cəhd kömək etmir (UpstreamError-dan fərqli). */
export class ModelResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelResponseError';
  }
}
