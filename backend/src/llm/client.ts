import { UpstreamError } from '../rag/clients.js';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}
export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
}
export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  /** Cavabı verən model/versiya (messages.model_version) */
  model: string;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;
}

export interface LlmClient {
  chat(req: ChatRequest, onDelta?: (text: string) => void): Promise<ChatResult>;
}

interface Delta {
  content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

/** OpenAI-uyğun `POST /v1/chat/completions` (stream + tools). Axın və axınsız cavabların ikisini də qəbul edir. */
export class HttpLlmClient implements LlmClient {
  constructor(
    private readonly o: {
      baseUrl: string;
      apiKey?: string | undefined;
      model: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async chat(req: ChatRequest, onDelta?: (text: string) => void): Promise<ChatResult> {
    const signals = [
      AbortSignal.timeout(this.o.timeoutMs ?? 90_000),
      ...(req.signal ? [req.signal] : []),
    ];
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(new URL('/v1/chat/completions', this.o.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.o.model,
          messages: req.messages,
          ...(req.tools?.length ? { tools: req.tools, tool_choice: 'auto' } : {}),
          max_tokens: req.maxTokens ?? 1024,
          stream: Boolean(onDelta),
          temperature: 0,
        }),
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      throw new UpstreamError(`LLM unreachable: ${(e as Error).message}`, { cause: e });
    }
    if (!res.ok) throw new UpstreamError(`LLM returned HTTP ${res.status}`);

    if ((res.headers.get('content-type') ?? '').includes('text/event-stream'))
      return this.readStream(res, onDelta);
    const body = (await res.json().catch(() => null)) as {
      model?: string;
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: ToolCall[] };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    const choice = body?.choices?.[0];
    if (!choice?.message) throw new UpstreamError('LLM response has no message');
    const content = choice.message.content ?? '';
    if (content) onDelta?.(content);
    return {
      content,
      toolCalls: choice.message.tool_calls ?? [],
      model: body?.model ?? this.o.model,
      finishReason: choice.finish_reason ?? null,
      usage: body?.usage
        ? {
            promptTokens: body.usage.prompt_tokens ?? 0,
            completionTokens: body.usage.completion_tokens ?? 0,
          }
        : null,
    };
  }

  private async readStream(res: Response, onDelta?: (t: string) => void): Promise<ChatResult> {
    let content = '';
    let model = this.o.model;
    let finish: string | null = null;
    let usage: ChatResult['usage'] = null;
    const calls = new Map<number, ToolCall>();
    const decoder = new TextDecoder();
    let buf = '';
    const handle = (payload: string) => {
      if (payload === '[DONE]') return;
      let j: {
        model?: string;
        choices?: Array<{ delta?: Delta; finish_reason?: string | null }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        j = JSON.parse(payload);
      } catch {
        throw new UpstreamError('LLM stream contained invalid JSON');
      }
      if (j.model) model = j.model;
      if (j.usage)
        usage = {
          promptTokens: j.usage.prompt_tokens ?? 0,
          completionTokens: j.usage.completion_tokens ?? 0,
        };
      const ch = j.choices?.[0];
      if (!ch) return;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta;
      if (d?.content) {
        content += d.content;
        onDelta?.(d.content);
      }
      for (const tc of d?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const cur = calls.get(i) ?? {
          id: '',
          type: 'function' as const,
          function: { name: '', arguments: '' },
        };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        calls.set(i, cur);
      }
    };
    try {
      for await (const chunk of res.body ?? []) {
        buf += decoder.decode(chunk as Uint8Array, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line.startsWith('data:')) handle(line.slice(5).trim());
        }
      }
      if (buf.startsWith('data:')) handle(buf.slice(5).trim());
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      throw new UpstreamError(`LLM stream failed: ${(e as Error).message}`, { cause: e });
    }
    return {
      content,
      toolCalls: [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, c], i) => ({ ...c, id: c.id || `call_${i}` })),
      model,
      finishReason: finish,
      usage,
    };
  }
}
