import { maskJsonValue } from '../audit/pii.js';
import type { Db, Repos } from '../db/index.js';
import type { ChatMessage, LlmClient, ToolCall } from '../llm/client.js';
import { NO_SOURCE_MESSAGE, resolveCitations } from '../rag/citations.js';
import { UpstreamError } from '../rag/clients.js';
import { hybridSearch } from '../rag/search.js';
import type { ObjectStorage } from '../storage/index.js';
import type { RagOcrClient } from '../ragocr/client.js';
import type { ModelServing } from '../models/client.js';
import type { Embedder, Reranker } from '../rag/clients.js';
import type { ToolGateway, GatewayOutcome } from './gateway.js';
import { systemPrompt } from './prompt.js';
import { SourceAccumulator, ToolRegistry, type ToolContext } from './tools.js';

export interface AgentLimits {
  maxSteps: number;
  maxToolCallsPerStep: number;
  maxTotalToolCalls: number;
  timeoutMs: number;
  maxTokens: number;
  historyChars: number;
}
export const DEFAULT_LIMITS: AgentLimits = {
  maxSteps: 8,
  maxToolCallsPerStep: 4,
  maxTotalToolCalls: 12,
  timeoutMs: 120_000,
  maxTokens: 1024,
  historyChars: 24_000,
};

export type AgentEvent =
  | { type: 'message.created'; messageId: string }
  | { type: 'step'; n: number }
  | { type: 'delta'; text: string }
  | { type: 'tool.call'; callId: string; tool: string; arguments: unknown }
  | {
      type: 'tool.result';
      callId: string;
      tool: string;
      status: GatewayOutcome['status'];
      summary: string;
      toolRunId: string;
      approvalId?: string;
    }
  | {
      type: 'final';
      messageId: string;
      content: string;
      citations: Array<{ label: string; chunkId: string }>;
      model: string;
    }
  | {
      type: 'error';
      code: 'STEP_LIMIT' | 'TOOL_LIMIT' | 'TIMEOUT' | 'UPSTREAM_UNAVAILABLE' | 'INTERNAL';
      message: string;
    };

export interface AgentDeps {
  llm: LlmClient;
  registry: ToolRegistry;
  gateway: ToolGateway;
  repos: Repos;
  db: Db;
  embedder?: Embedder | undefined;
  reranker?: Reranker | undefined;
  models?: ModelServing | undefined;
  storage?: ObjectStorage | undefined;
  ragOcr?: RagOcrClient | undefined;
  limits?: Partial<AgentLimits>;
  now?: () => Date;
  log?: { warn(o: object, m: string): void };
}

export interface TurnInput {
  companyId: string;
  userId: string;
  permissions: readonly string[];
  requestId: string;
  conversationId: string;
  text: string;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
  minSimilarity?: number;
}

const SEARCH_TOOLS = new Set(['legislation.search', 'news.search', 'files.search']);

/** Saxlanılan mesajlardan LLM tarixçəsi; ən köhnədən kəsilir, yetim `tool` mesajları atılır. */
export function buildHistory(
  rows: Array<{ role: string; content: string; toolCalls: unknown; toolCallId: string | null }>,
  maxChars: number,
): ChatMessage[] {
  let total = 0;
  const kept: typeof rows = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    total += rows[i]!.content.length + 50;
    if (total > maxChars && kept.length > 0) break;
    kept.unshift(rows[i]!);
  }
  while (kept.length > 0 && kept[0]!.role === 'tool') kept.shift();
  return kept.map((m): ChatMessage =>
    m.role === 'tool'
      ? { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' }
      : m.role === 'assistant'
        ? {
            role: 'assistant',
            content: m.content || null,
            ...(Array.isArray(m.toolCalls) ? { tool_calls: m.toolCalls as ToolCall[] } : {}),
          }
        : { role: 'user', content: m.content },
  );
}

export async function runTurn(deps: AgentDeps, input: TurnInput): Promise<void> {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => new Date());
  const { repos } = deps;
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
  const sources = new SourceAccumulator();
  let searchUsed = false;
  let model = 'unknown';

  const userMsg = await repos.assistant.addMessage({
    companyId: input.companyId,
    conversationId: input.conversationId,
    role: 'user',
    content: input.text,
  });
  await repos.assistant.touchConversation(input.conversationId, input.text.slice(0, 80));
  input.emit({ type: 'message.created', messageId: userMsg.id });

  const toolCtx = (): ToolContext => ({
    companyId: input.companyId,
    userId: input.userId,
    permissions: input.permissions,
    requestId: input.requestId,
    conversationId: input.conversationId,
    repos,
    db: deps.db,
    models: deps.models,
    storage: deps.storage,
    ragOcr: deps.ragOcr,
    sources,
    now: now(),
    // company_id burada SABİTLƏNİR: alətlər onu parametr kimi görmür
    search: (req) =>
      hybridSearch(
        { repos, embedder: deps.embedder, reranker: deps.reranker, log: deps.log },
        {
          ...req,
          companyId: input.companyId,
          minSimilarity: input.minSimilarity ?? req.minSimilarity,
        },
      ),
  });

  const tools = deps.registry.specsFor(input.permissions);
  const history = buildHistory(
    await repos.assistant.listMessages(input.companyId, input.conversationId, 60),
    limits.historyChars,
  );
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(now().toISOString().slice(0, 10)) },
    ...history,
  ];
  let totalCalls = 0;

  try {
    for (let step = 1; step <= limits.maxSteps; step++) {
      input.emit({ type: 'step', n: step });
      const res = await deps.llm.chat(
        { messages, tools, maxTokens: limits.maxTokens, signal },
        (text) => input.emit({ type: 'delta', text }),
      );
      model = res.model;

      if (res.toolCalls.length === 0) {
        // Yekun cavab: sitatlar yoxlanılır, mənbəsiz hüquqi iddia buraxılmır
        let content = res.content.trim();
        let citations: Array<{ label: string; chunkId: string }> = [];
        if (sources.hits.length > 0) {
          const r = resolveCitations(content, sources.hits);
          content = r.text;
          citations = r.citations;
        } else if (searchUsed) {
          content = NO_SOURCE_MESSAGE; // axtarış aparıldı, heç nə tapılmadı
        } else {
          content = content
            .replace(/\[\s*S\d+(?:\s*[,;]\s*S\d+)*\s*\]/gi, '')
            .replace(/[ \t]+([.,;:!?])/g, '$1')
            .replace(/[ \t]{2,}/g, ' ')
            .trim(); // mənbə olmadan uydurma [S#] qalmasın
        }
        if (!content) content = NO_SOURCE_MESSAGE;
        const saved = await repos.assistant.addMessage({
          companyId: input.companyId,
          conversationId: input.conversationId,
          role: 'assistant',
          content,
          citations,
          modelVersion: model,
        });
        await repos.assistant.touchConversation(input.conversationId);
        input.emit({ type: 'final', messageId: saved.id, content, citations, model });
        return;
      }

      await repos.assistant.addMessage({
        companyId: input.companyId,
        conversationId: input.conversationId,
        role: 'assistant',
        content: res.content,
        toolCalls: res.toolCalls,
        modelVersion: model,
      });
      messages.push({ role: 'assistant', content: res.content || null, tool_calls: res.toolCalls });

      for (const [i, call] of res.toolCalls.entries()) {
        if (signal.aborted) throw signal.reason ?? new Error('aborted');
        let tool = ToolRegistryName(call);
        let content: string;
        if (i >= limits.maxToolCallsPerStep || totalCalls >= limits.maxTotalToolCalls) {
          content = JSON.stringify({
            error: 'TOO_MANY_TOOL_CALLS',
            message: 'Tool call budget exceeded; answer with what you have.',
          });
          tool = tool || 'unknown';
          input.emit({
            type: 'tool.result',
            callId: call.id,
            tool,
            status: 'rejected',
            summary: 'tool call budget exceeded',
            toolRunId: '',
          });
        } else {
          totalCalls++;
          let args: unknown = null;
          try {
            args = maskJsonValue(JSON.parse(call.function.arguments || '{}'));
          } catch {
            args = { unparsable: true };
          }
          input.emit({ type: 'tool.call', callId: call.id, tool, arguments: args });
          const out = await deps.gateway.execute(toolCtx(), {
            wireName: call.function.name,
            rawArguments: call.function.arguments,
          });
          if (out.status === 'succeeded' && SEARCH_TOOLS.has(tool)) searchUsed = true;
          input.emit({
            type: 'tool.result',
            callId: call.id,
            tool,
            status: out.status,
            summary: out.summary.slice(0, 300),
            toolRunId: out.toolRunId,
            ...(out.approvalId ? { approvalId: out.approvalId } : {}),
          });
          content = out.content;
        }
        await repos.assistant.addMessage({
          companyId: input.companyId,
          conversationId: input.conversationId,
          role: 'tool',
          content,
          toolCallId: call.id,
        });
        messages.push({ role: 'tool', content, tool_call_id: call.id });
      }
      if (totalCalls >= limits.maxTotalToolCalls && step < limits.maxSteps) {
        // büdcə bitdi: növbəti addım alətsiz cavab verməlidir
        tools.length = 0;
      }
    }
    const text =
      'I could not finish within the allowed number of steps. Please narrow the question.';
    const saved = await repos.assistant.addMessage({
      companyId: input.companyId,
      conversationId: input.conversationId,
      role: 'assistant',
      content: text,
      modelVersion: model,
    });
    input.emit({ type: 'error', code: 'STEP_LIMIT', message: text });
    input.emit({ type: 'final', messageId: saved.id, content: text, citations: [], model });
  } catch (e) {
    if (signal.aborted && timeout.aborted)
      input.emit({ type: 'error', code: 'TIMEOUT', message: 'The assistant timed out.' });
    else if (input.signal?.aborted)
      return; // müştəri ayrıldı
    else if (e instanceof UpstreamError)
      input.emit({
        type: 'error',
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'The language model is unavailable. Please retry later.',
      });
    else {
      deps.log?.warn({ err: String(e) }, 'agent turn failed');
      input.emit({ type: 'error', code: 'INTERNAL', message: 'The assistant failed.' });
    }
  }
}

function ToolRegistryName(call: ToolCall): string {
  return ToolRegistry.fromWireName(call.function.name);
}
