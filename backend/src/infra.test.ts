import { describe, expect, it } from 'vitest';
import { testConfig } from './config.js';
import { createInfra } from './infra.js';

describe('AI service wiring', () => {
  it('keeps the backend usable without AI services and names the unavailable features', async () => {
    const infra = await createInfra(testConfig());
    expect(infra.models).toBeUndefined();
    expect(infra.llm).toBeUndefined();
    expect(infra.ragOcr).toBeUndefined();
    expect(infra.warnings.join('\n')).toContain('assistant chat, invoice extraction');
  });

  it('enables sidecar OCR without pretending that the sidecar implements the model server', async () => {
    const infra = await createInfra(
      testConfig({
        ragOcr: { baseUrl: 'http://rag.local', token: 'test-token' },
      }),
    );
    expect(infra.ragOcr).toBeDefined();
    expect(infra.models).toBeDefined();
    expect(infra.llm).toBeUndefined();
    expect(infra.embedder).toBeUndefined();
    expect(infra.models?.listModels).toBeUndefined();
    await expect(infra.models!.extractInvoice('invoice')).rejects.toThrow(
      /compatible model server/,
    );
    await expect(
      infra.models!.classifyAccount({
        description: 'Paper',
        direction: 'purchase',
        standard: 'MMUS',
      }),
    ).rejects.toThrow(/MODEL_SERVING_BASE_URL/);
  });

  it('keeps every capability when both services are configured', async () => {
    const infra = await createInfra(
      testConfig({
        modelServingBaseUrl: 'http://models.local',
        ragOcr: { baseUrl: 'http://rag.local', token: 'test-token' },
      }),
    );
    expect(infra.ragOcr).toBeDefined();
    expect(infra.llm).toBeDefined();
    expect(infra.embedder).toBeDefined();
    expect(infra.reranker).toBeDefined();
    expect(infra.models?.listModels).toBeTypeOf('function');
    expect(infra.warnings.join('\n')).not.toContain('MODEL_SERVING_BASE_URL is not set');
  });
});
