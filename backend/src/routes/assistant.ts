import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditRequest } from '../audit/http.js';
import { runTurn, type AgentEvent } from '../agent/orchestrator.js';
import { PERMISSIONS } from '../domain/index.js';
import { ApiError, errorResponses } from '../error.js';
import { requireAuth } from '../plugins/auth.js';

const ConversationSchema = z.object({
  id: z.uuid(),
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const MessageSchema = z.object({
  id: z.uuid(),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  citations: z.array(z.object({ label: z.string(), chunkId: z.uuid() })),
  toolCalls: z.array(z.object({ id: z.string(), name: z.string() })).nullable(),
  modelVersion: z.string().nullable(),
  createdAt: z.string(),
});
const IdParams = z.object({ id: z.uuid() });

const conv = (c: { id: string; title: string | null; createdAt: Date; updatedAt: Date }) => ({
  id: c.id,
  title: c.title,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

export default async function assistantRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const active = new Set<string>(); // söhbət başına eyni anda bir növbə

  typed.post(
    '/api/v1/conversations',
    {
      schema: {
        tags: ['assistant'],
        security: [{ bearerAuth: [] }],
        body: z.object({ title: z.string().trim().max(200).optional() }).default({}),
        response: { 201: ConversationSchema, ...errorResponses(401, 403, 422) },
      },
      config: { permission: PERMISSIONS.ASSISTANT_USE },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const c = await app.ctx.db.tx(async (tx) => {
        const { createRepos } = await import('../db/index.js');
        const r = createRepos(tx);
        const created = await r.assistant.createConversation(
          auth.companyId,
          auth.userId,
          request.body.title ?? null,
        );
        await auditRequest(
          app,
          request,
          { action: 'conversation.create', resourceType: 'conversation', resourceId: created.id },
          tx,
        );
        return created;
      });
      void reply.status(201);
      return conv(c);
    },
  );

  typed.get(
    '/api/v1/conversations',
    {
      schema: {
        tags: ['assistant'],
        security: [{ bearerAuth: [] }],
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }),
        response: { 200: z.array(ConversationSchema), ...errorResponses(401, 403, 422) },
      },
      config: { permission: PERMISSIONS.ASSISTANT_USE },
    },
    async (request) => {
      const auth = requireAuth(request);
      return (
        await app.ctx.repos.assistant.listConversations(
          auth.companyId,
          auth.userId,
          request.query.limit,
        )
      ).map(conv);
    },
  );

  typed.get(
    '/api/v1/conversations/:id',
    {
      schema: {
        tags: ['assistant'],
        summary: 'Söhbət və mesajlar (alət nəticələri daxil deyil)',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          200: ConversationSchema.extend({ messages: z.array(MessageSchema) }),
          ...errorResponses(401, 403, 404, 422),
        },
      },
      config: { permission: PERMISSIONS.ASSISTANT_USE },
    },
    async (request) => {
      const auth = requireAuth(request);
      const c = await app.ctx.repos.assistant.getConversation(
        auth.companyId,
        auth.userId,
        request.params.id,
      );
      if (!c) throw ApiError.notFound('Conversation not found'); // başqasının söhbəti də 404
      const msgs = await app.ctx.repos.assistant.listMessages(auth.companyId, c.id);
      return {
        ...conv(c),
        messages: msgs
          .filter((m) => m.role !== 'tool')
          .map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            citations: (m.citations as Array<{ label: string; chunkId: string }>) ?? [],
            toolCalls: Array.isArray(m.toolCalls)
              ? (m.toolCalls as Array<{ id: string; function: { name: string } }>).map((t) => ({
                  id: t.id,
                  name: t.function.name.replaceAll('__', '.'),
                }))
              : null,
            modelVersion: m.modelVersion,
            createdAt: m.createdAt.toISOString(),
          })),
      };
    },
  );

  typed.post(
    '/api/v1/conversations/:id/messages',
    {
      schema: {
        tags: ['assistant'],
        summary:
          'Mesaj göndər → SSE axını (message.created, step, delta, tool.call, tool.result, final, error, done)',
        description:
          'Cavab `text/event-stream`dir. Hər agent addımı ayrıca event kimi gəlir. Model yalnız alət TƏKLİF edir; icranı Tool Gateway yoxlayır.',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: z.object({ content: z.string().trim().min(1).max(4000) }),
        response: errorResponses(401, 403, 404, 409, 422, 429, 503),
      },
      config: { permission: PERMISSIONS.ASSISTANT_USE, skipAudit: true },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const llm = app.ctx.llm;
      if (!llm) throw ApiError.upstream('The language model is not configured');
      const c = await app.ctx.repos.assistant.getConversation(
        auth.companyId,
        auth.userId,
        request.params.id,
      );
      if (!c) throw ApiError.notFound('Conversation not found');
      const rl = app.ctx.rateLimiter.check(
        `chat:${auth.userId}`,
        app.ctx.config.chatRateLimitPerMinute,
        60,
      );
      if (!rl.allowed) {
        void reply.header('retry-after', String(rl.retryAfterSeconds));
        throw ApiError.rateLimited('Too many messages. Please slow down.');
      }
      if (active.has(c.id))
        throw ApiError.conflict('The assistant is still answering the previous message');
      active.add(c.id);

      // SSE: hijack olunur, başlıqlar (CORS, x-request-id) əvvəlcədən qoyulanlardan götürülür
      void reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        ...reply.getHeaders(),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-request-id': request.id,
      } as Record<string, string>);
      const abort = new AbortController();
      request.raw.on('close', () => {
        if (!raw.writableEnded) abort.abort();
      });
      const send = (event: string, data: unknown) => {
        if (!raw.writableEnded && !raw.destroyed)
          raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const heartbeat = setInterval(() => {
        if (!raw.writableEnded) raw.write(': keep-alive\n\n');
      }, 15_000);
      let toolRuns = 0;
      let finalId: string | null = null;
      try {
        await runTurn(
          {
            llm,
            registry: app.ctx.tools,
            gateway: app.ctx.gateway,
            repos: app.ctx.repos,
            db: app.ctx.db,
            embedder: app.ctx.embedder,
            reranker: app.ctx.reranker,
            log: app.log,
          },
          {
            companyId: auth.companyId,
            userId: auth.userId,
            permissions: auth.permissions,
            requestId: request.id,
            conversationId: c.id,
            text: request.body.content,
            signal: abort.signal,
            minSimilarity: app.ctx.config.ragMinSimilarity,
            emit: (e: AgentEvent) => {
              if (e.type === 'tool.result') toolRuns++;
              if (e.type === 'final') finalId = e.messageId;
              const { type, ...data } = e;
              send(type, data);
            },
          },
        );
        await auditRequest(app, request, {
          action: 'assistant.message',
          resourceType: 'conversation',
          resourceId: c.id,
          after: { messageId: finalId, toolRuns },
        }).catch((err) => app.log.error({ err }, 'audit of assistant turn failed'));
      } finally {
        clearInterval(heartbeat);
        active.delete(c.id);
        send('done', {});
        raw.end();
      }
    },
  );

  typed.post(
    '/api/v1/messages/:id/feedback',
    {
      schema: {
        tags: ['assistant'],
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('thumbs'),
            value: z.enum(['up', 'down']),
            comment: z.string().trim().max(1000).optional(),
          }),
          z.object({
            kind: z.literal('correction'),
            correction: z.string().trim().min(1).max(4000),
          }),
        ]),
        response: { 201: z.object({ id: z.uuid() }), ...errorResponses(401, 403, 404, 422) },
      },
      config: { permission: PERMISSIONS.ASSISTANT_USE },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const msg = await app.ctx.repos.assistant.getOwnMessage(
        auth.companyId,
        auth.userId,
        request.params.id,
      );
      if (!msg || msg.role !== 'assistant') throw ApiError.notFound('Message not found');
      const b = request.body;
      const id = await app.ctx.db.tx(async (tx) => {
        const { createRepos } = await import('../db/index.js');
        const fid = await createRepos(tx).assistant.addFeedback({
          companyId: auth.companyId,
          userId: auth.userId,
          messageId: msg.id,
          kind: b.kind,
          before: { content: msg.content, modelVersion: msg.modelVersion },
          after:
            b.kind === 'thumbs'
              ? { value: b.value, comment: b.comment ?? null }
              : { correction: b.correction },
        });
        await auditRequest(
          app,
          request,
          {
            action: 'message.feedback',
            resourceType: 'message',
            resourceId: msg.id,
            after: { kind: b.kind },
          },
          tx,
        );
        return fid;
      });
      void reply.status(201);
      return { id };
    },
  );
}
