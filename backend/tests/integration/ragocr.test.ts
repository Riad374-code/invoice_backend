import { describe, expect, it } from 'vitest';
import { registerBuiltinTools } from '../../src/agent/builtin-tools.js';
import { SourceAccumulator, ToolRegistry, type ToolContext } from '../../src/agent/tools.js';
import { HttpModelServing, ModelResponseError } from '../../src/models/client.js';
import { UpstreamError } from '../../src/rag/clients.js';
import { HttpRagOcr, withRagOcr, type RagOcrClient } from '../../src/ragocr/client.js';

const DOC = '3f0c2c9e-6a4b-4d6e-9d7e-1a2b3c4d5e6f';
const record = {
  document_id: DOC,
  review_status: 'needs_review',
  fields: { raw_text: 'SOCAR', supplier: 'SOCAR', total_amount: '10.00', line_items: [] },
  validation: { issues: [] },
};
const jsonRes = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function client(handler: (url: URL, init: RequestInit) => Response) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const c = new HttpRagOcr({
    baseUrl: 'http://rag.local',
    token: 'secret',
    fetchImpl: (async (u: URL, init: RequestInit) => {
      calls.push({ url: u, init });
      return handler(u, init);
    }) as unknown as typeof fetch,
  });
  return { c, calls };
}

describe('HttpRagOcr', () => {
  it('sends the bearer token and company id, validates the contract', async () => {
    const { c, calls } = client(() => jsonRes({ results: [] }));
    await c.searchDocuments({ companyId: 'co1', query: 'yanacaq', topK: 3 });
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer secret',
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ companyId: 'co1', topK: 3 });
    const bad = client(() => jsonRes({ nope: 1 }));
    await expect(bad.c.searchRegulations('x', 3)).rejects.toBeInstanceOf(ModelResponseError);
  });
  it('maps 404 to null, 422 to a permanent error and 5xx to a retryable one', async () => {
    expect(await client(() => jsonRes({}, 404)).c.getDocument('co1', DOC)).toBeNull();
    await expect(
      client(() => jsonRes({ detail: 'bad' }, 422)).c.getDocument('co1', DOC),
    ).rejects.toBeInstanceOf(ModelResponseError);
    await expect(
      client(() => jsonRes({}, 502)).c.ocr(Buffer.from('x'), 'image/png'),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
  it('ocr() feeds the existing ModelServing.ocr contract', async () => {
    const { c } = client(() => jsonRes({ text: 'çek mətni', model: 'gemini' }));
    const models = withRagOcr(undefined, c);
    expect(await models.ocr(Buffer.from('x'), 'image/png')).toMatchObject({ text: 'çek mətni' });
    await expect(models.classifyNews('x')).rejects.toBeInstanceOf(UpstreamError);
  });
  it('preserves real model-client methods and their instance when adding sidecar OCR', async () => {
    const requests: string[] = [];
    const base = new HttpModelServing({
      baseUrl: 'http://models.local',
      apiKey: 'model-token',
      fetchImpl: (async (url: URL, init: RequestInit) => {
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer model-token');
        requests.push(url.pathname);
        if (url.pathname === '/v1/models') return jsonRes({ data: [{ id: 'fixture-model' }] });
        if (url.pathname === '/v1/classify/news')
          return jsonRes({
            category: 'tax',
            riskLevel: 'low',
            summary: 'Fixture',
            model: 'fixture-model',
          });
        if (url.pathname === '/v1/classify/account')
          return jsonRes({ accountCode: '721', confidence: 0.7, model: 'fixture-model' });
        return jsonRes({
          invoice: {
            number: 'INV-1',
            issueDate: '2026-10-09',
            seller: { name: 'Seller' },
            buyer: { name: 'Buyer' },
            lines: [{ description: 'Paper', qty: '1', unitPrice: '10', net: '10', vat: '0' }],
          },
          overallConfidence: 0.7,
          model: 'fixture-model',
        });
      }) as unknown as typeof fetch,
    });
    const { c, calls } = client(() => jsonRes({ text: 'sidecar text', model: 'ocr-model' }));
    const models = withRagOcr(base, c);
    expect(await models.extractInvoice('invoice text')).toMatchObject({ model: 'fixture-model' });
    expect(await models.classifyNews('news text')).toMatchObject({ category: 'tax' });
    expect(
      await models.classifyAccount({
        description: 'Paper',
        direction: 'purchase',
        standard: 'MMUS',
      }),
    ).toMatchObject({ accountCode: '721' });
    expect(await models.listModels?.()).toEqual([{ id: 'fixture-model' }]);
    expect(await models.ocr(Buffer.from('scan'), 'image/png')).toEqual({
      text: 'sidecar text',
      model: 'ocr-model',
    });
    expect(requests).toEqual([
      '/v1/extract/invoice',
      '/v1/classify/news',
      '/v1/classify/account',
      '/v1/models',
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe('/v1/ocr');
  });
});

describe('agent tools over the sidecar', () => {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  const seen: string[] = [];
  const rag: RagOcrClient = {
    searchRegulations: async () => [
      {
        id: 'c1',
        article: '13',
        title: 'Xərclər',
        text: 'Gəlirdən çıxılan xərclər',
        validity_verified: false,
      },
    ],
    searchDocuments: async (r) => {
      seen.push(r.companyId);
      return [
        { document_id: DOC, score: 0.8, review_status: 'needs_review', fields: record.fields },
      ];
    },
    getDocument: async (companyId) => (seen.push(companyId), companyId === 'co1' ? record : null),
    ingestDocument: async () => record,
    ocr: async () => ({ text: 't', model: 'm' }),
  };
  const ctx = (o: Partial<ToolContext> = {}) =>
    ({ companyId: 'co1', ragOcr: rag, sources: new SourceAccumulator(), ...o }) as ToolContext;

  it('regulations.search registers a citable source and flags unverified validity', async () => {
    const c = ctx();
    const out = (await registry
      .get('regulations.search')!
      .handler(c, { query: 'xərclər', limit: 3 })) as {
      results: Array<{ label: string; validityVerified: boolean }>;
    };
    expect(out.results[0]).toMatchObject({ label: 'S1', validityVerified: false });
    expect(c.sources.hits[0]!.articleRef).toContain('13');
  });
  it('receipt tools take the company from the session and reject a model-supplied companyId', async () => {
    const t = registry.get('receipts.search')!;
    expect(t.args.safeParse({ query: 'yanacaq', companyId: 'other' }).success).toBe(false);
    await t.handler(ctx(), { query: 'yanacaq', limit: 5 });
    await registry.get('receipts.get')!.handler(ctx({ companyId: 'co2' }), { documentId: DOC });
    expect(seen).toEqual(['co1', 'co2']);
    expect(
      await registry.get('receipts.get')!.handler(ctx({ companyId: 'co2' }), { documentId: DOC }),
    ).toEqual({ error: 'NOT_FOUND' });
  });
  it('fails clearly when the sidecar is not configured', async () => {
    await expect(
      registry
        .get('regulations.search')!
        .handler(ctx({ ragOcr: undefined }), { query: 'x y', limit: 1 }),
    ).rejects.toThrow(/RAG_OCR_BASE_URL/);
  });
});
