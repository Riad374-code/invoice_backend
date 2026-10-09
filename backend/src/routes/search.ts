import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertLocalDate } from '../accounting/index.js';
import type { ResourceType } from '../db/repos/chunks.js';
import { PERMISSIONS } from '../domain/index.js';
import { ApiError, errorResponses } from '../error.js';
import { requireAuth } from '../plugins/auth.js';
import { hybridSearch } from '../rag/search.js';

const TYPE_PERMISSION: Record<ResourceType, string> = {
  legislation: PERMISSIONS.LEGISLATION_READ,
  news: PERMISSIONS.NEWS_READ,
  file: PERMISSIONS.FILES_READ,
  audit: PERMISSIONS.AUDIT_READ,
};

const HitSchema = z.object({
  label: z.string(),
  chunkId: z.uuid(),
  resourceType: z.enum(['legislation', 'news', 'file', 'audit']),
  resourceId: z.uuid(),
  title: z.string(),
  articleRef: z.string().nullable(),
  versionNo: z.number().int().nullable(),
  url: z.string().nullable(),
  text: z.string(),
  scores: z.object({ rrf: z.number(), rerank: z.number().nullable() }),
});

export default async function searchRoutes(app: FastifyInstance) {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/api/v1/search',
    {
      schema: {
        tags: ['search'],
        summary: 'Hybrid axtarış: pgvector + full-text → RRF → rerank (top 8)',
        description:
          'company_id sessiyadan götürülür. Nəticələr istifadəçinin icazəsi olan resurs növləri ilə məhdudlaşır. `date` — qanunun həmin gün qüvvədə olan versiyası.',
        security: [{ bearerAuth: [] }],
        body: z.object({
          query: z.string().trim().min(2).max(1000),
          resourceTypes: z
            .array(z.enum(['legislation', 'news', 'file', 'audit']))
            .min(1)
            .optional(),
          date: z.string().optional(),
          limit: z.number().int().min(1).max(20).default(8),
        }),
        response: {
          200: z.object({
            query: z.string(),
            language: z.enum(['az', 'ru', 'en']),
            modes: z.array(z.enum(['vector', 'fulltext'])),
            reranked: z.boolean(),
            hits: z.array(HitSchema),
            message: z.string().nullable(),
          }),
          ...errorResponses(401, 403, 422),
        },
      },
      // Auth tələb olunur; icazə resurs növü üzrə aşağıda süzülür (heç bir icazə yoxdursa 403)
      config: { authOnly: true, skipAudit: true },
    },
    async (request) => {
      const auth = requireAuth(request);
      const requested =
        request.body.resourceTypes ?? (['legislation', 'news', 'file'] as ResourceType[]);
      const allowed = requested.filter((t) => auth.permissions.includes(TYPE_PERMISSION[t]));
      if (allowed.length === 0)
        throw ApiError.forbidden('No permission for the requested resource types');
      let date = request.body.date;
      if (date !== undefined) {
        try {
          assertLocalDate(date);
        } catch {
          throw ApiError.validation('date must be YYYY-MM-DD');
        }
      } else date = new Date().toISOString().slice(0, 10);

      const res = await hybridSearch(
        {
          repos: app.ctx.repos,
          embedder: app.ctx.embedder,
          reranker: app.ctx.reranker,
          log: app.log,
        },
        {
          query: request.body.query,
          companyId: auth.companyId,
          resourceTypes: allowed,
          date,
          topK: request.body.limit,
          minSimilarity: app.ctx.config.ragMinSimilarity,
        },
      );
      return {
        query: res.query,
        language: res.language,
        modes: res.modes,
        reranked: res.reranked,
        message: res.message,
        hits: res.hits.map((h) => ({
          label: h.label,
          chunkId: h.chunkId,
          resourceType: h.resourceType,
          resourceId: h.resourceId,
          title: h.sourceTitle,
          articleRef: h.articleRef,
          versionNo: h.versionNo,
          url: h.url,
          text: h.text,
          scores: h.scores,
        })),
      };
    },
  );
}
