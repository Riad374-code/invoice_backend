import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditRequest } from '../audit/http.js';
import { assertLocalDate } from '../accounting/index.js';
import type { LegVersionRow, NewsRow } from '../db/repos/ingestion.js';
import { PERMISSIONS } from '../domain/index.js';
import { ApiError, errorResponses } from '../error.js';
import { diffText } from '../ingestion/diff.js';
import { requireAuth } from '../plugins/auth.js';

const NewsSchema = z.object({
  id: z.uuid(),
  sourceId: z.uuid(),
  title: z.string(),
  originalUrl: z.string(),
  publishedAt: z.string().nullable(),
  fetchedAt: z.string(),
  excerpt: z.string(),
  aiSummary: z.string().nullable(),
  aiCategory: z.string().nullable(),
  aiRiskLevel: z.string().nullable(),
  aiTags: z.array(z.string()).nullable(),
  read: z.boolean(),
  bookmarked: z.boolean(),
});
const toNews = (n: NewsRow) => ({
  id: n.id,
  sourceId: n.sourceId,
  title: n.title,
  originalUrl: n.originalUrl,
  publishedAt: n.publishedAt?.toISOString() ?? null,
  fetchedAt: n.fetchedAt.toISOString(),
  excerpt: n.rawText.slice(0, 400),
  aiSummary: n.aiSummary,
  aiCategory: n.aiCategory,
  aiRiskLevel: n.aiRiskLevel,
  aiTags: n.aiTags,
  read: n.read,
  bookmarked: n.bookmarked,
});
const DocSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  officialNumber: z.string().nullable(),
  adoptedAt: z.string().nullable(),
  title: z.string(),
  language: z.string(),
  sourceUrl: z.string(),
  latestVersionNo: z.number().int().nullable(),
  currentValidFrom: z.string().nullable(),
});
const VersionMeta = z.object({
  versionNo: z.number().int(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  contentHash: z.string(),
  sourceUrl: z.string(),
});
const meta = (v: LegVersionRow) => ({
  versionNo: v.versionNo,
  validFrom: v.validFrom,
  validTo: v.validTo,
  contentHash: v.contentHash,
  sourceUrl: v.sourceUrl,
});
const IdParams = z.object({ id: z.uuid() });

export default async function knowledgeRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const ing = () => app.ctx.repos.ingestion;

  // ------------------------------------------------------------- news
  typed.get(
    '/api/v1/news',
    {
      schema: {
        tags: ['news'],
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          sourceId: z.uuid().optional(),
          unread: z.stringbool().optional(),
          bookmarked: z.stringbool().optional(),
          q: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          cursor: z.string().max(200).optional(),
        }),
        response: {
          200: z.object({ items: z.array(NewsSchema), nextCursor: z.string().nullable() }),
          ...errorResponses(401, 403, 422),
        },
      },
      config: { permission: PERMISSIONS.NEWS_READ },
    },
    async (request) => {
      const auth = requireAuth(request);
      const q = request.query;
      let cursor;
      if (q.cursor) {
        try {
          const c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString()) as {
            t: string;
            i: string;
          };
          if (Number.isNaN(Date.parse(c.t))) throw new Error('bad');
          cursor = { t: c.t, id: z.uuid().parse(c.i) };
        } catch {
          throw ApiError.validation('Invalid cursor');
        }
      }
      const rows = await ing().listNews(auth.userId, { ...q, cursor });
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toNews),
        nextCursor:
          rows.length > q.limit && last
            ? Buffer.from(
                JSON.stringify({
                  t: (last.publishedAt ?? last.fetchedAt).toISOString(),
                  i: last.id,
                }),
              ).toString('base64url')
            : null,
      };
    },
  );

  typed.get(
    '/api/v1/news/:id',
    {
      schema: {
        tags: ['news'],
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          200: NewsSchema.extend({ rawText: z.string(), canonicalUrl: z.string() }),
          ...errorResponses(401, 403, 404, 422),
        },
      },
      config: { permission: PERMISSIONS.NEWS_READ },
    },
    async (request) => {
      const auth = requireAuth(request);
      const n = await ing().getNews(auth.userId, request.params.id);
      if (!n) throw ApiError.notFound(`News item ${request.params.id} not found`);
      return { ...toNews(n), rawText: n.rawText, canonicalUrl: n.canonicalUrl };
    },
  );

  for (const [path, field] of [
    ['read', 'read'],
    ['bookmark', 'bookmarked'],
  ] as const) {
    typed.put(
      `/api/v1/news/:id/${path}`,
      {
        schema: {
          tags: ['news'],
          summary: field === 'read' ? 'Oxundu işarəsi' : 'Seçilmişlərə əlavə et/çıxar',
          security: [{ bearerAuth: [] }],
          params: IdParams,
          body: z.object({ value: z.boolean().default(true) }).default({ value: true }),
          response: { 200: NewsSchema, ...errorResponses(401, 403, 404, 422) },
        },
        config: { permission: PERMISSIONS.NEWS_READ },
      },
      async (request) => {
        const auth = requireAuth(request);
        const existing = await ing().getNews(auth.userId, request.params.id);
        if (!existing) throw ApiError.notFound(`News item ${request.params.id} not found`);
        await app.ctx.db.tx(async (tx) => {
          const { createRepos } = await import('../db/index.js');
          const r = createRepos(tx);
          await r.ingestion.setNewsState(
            auth.userId,
            auth.companyId,
            existing.id,
            { [field]: request.body.value },
            new Date(),
          );
          await auditRequest(
            app,
            request,
            {
              action: `news.${path}`,
              resourceType: 'news_item',
              resourceId: existing.id,
              before: { [field]: existing[field] },
              after: { [field]: request.body.value },
            },
            tx,
          );
        });
        return toNews((await ing().getNews(auth.userId, existing.id))!);
      },
    );
  }

  // ------------------------------------------------------ legislation
  typed.get(
    '/api/v1/legislation',
    {
      schema: {
        tags: ['legislation'],
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          type: z.enum(['code', 'law', 'decree', 'cabinet_decision', 'standard']).optional(),
          q: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          offset: z.coerce.number().int().min(0).max(10_000).default(0),
        }),
        response: { 200: z.array(DocSchema), ...errorResponses(401, 403, 422) },
      },
      config: { permission: PERMISSIONS.LEGISLATION_READ },
    },
    async (request) =>
      (await ing().listDocuments(request.query)).map(({ canonicalUrl: _c, ...d }) => d),
  );

  const loadDoc = async (id: string) => {
    const d = await ing().getDocument(id);
    if (!d) throw ApiError.notFound(`Legislation document ${id} not found`);
    return d;
  };

  typed.get(
    '/api/v1/legislation/:id',
    {
      schema: {
        tags: ['legislation'],
        summary: 'Sənəd + tarixdə qüvvədə olan versiyanın mətni (`date` verilməsə — cari)',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        querystring: z.object({ date: z.string().optional() }),
        response: {
          200: DocSchema.extend({
            version: VersionMeta.extend({ fullText: z.string() }).nullable(),
          }),
          ...errorResponses(401, 403, 404, 422),
        },
      },
      config: { permission: PERMISSIONS.LEGISLATION_READ },
    },
    async (request) => {
      const d = await loadDoc(request.params.id);
      const { canonicalUrl: _c, ...doc } = d;
      let v: LegVersionRow | null;
      if (request.query.date) {
        try {
          assertLocalDate(request.query.date);
        } catch {
          throw ApiError.validation('date must be YYYY-MM-DD');
        }
        v = await ing().versionOn(d.id, request.query.date);
      } else v = (await ing().listVersions(d.id)).find((x) => x.validTo === null) ?? null;
      return { ...doc, version: v ? { ...meta(v), fullText: v.fullText } : null };
    },
  );

  typed.get(
    '/api/v1/legislation/:id/versions',
    {
      schema: {
        tags: ['legislation'],
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: { 200: z.array(VersionMeta), ...errorResponses(401, 403, 404, 422) },
      },
      config: { permission: PERMISSIONS.LEGISLATION_READ },
    },
    async (request) => {
      await loadDoc(request.params.id);
      return (await ing().listVersions(request.params.id)).map(meta);
    },
  );

  typed.get(
    '/api/v1/legislation/:id/diff',
    {
      schema: {
        tags: ['legislation'],
        summary: 'İki versiya arasında abzas səviyyəsində fərq (from/to = versiya nömrəsi)',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        querystring: z.object({
          from: z.coerce.number().int().min(1),
          to: z.coerce.number().int().min(1),
        }),
        response: {
          200: z.object({
            from: VersionMeta,
            to: VersionMeta,
            hunks: z.array(
              z.object({ type: z.enum(['added', 'removed', 'unchanged']), text: z.string() }),
            ),
          }),
          ...errorResponses(401, 403, 404, 422),
        },
      },
      config: { permission: PERMISSIONS.LEGISLATION_READ },
    },
    async (request) => {
      await loadDoc(request.params.id);
      const [a, b] = await Promise.all([
        ing().getVersion(request.params.id, request.query.from),
        ing().getVersion(request.params.id, request.query.to),
      ]);
      if (!a || !b) throw ApiError.notFound('Requested version does not exist');
      return { from: meta(a), to: meta(b), hunks: diffText(a.fullText, b.fullText) };
    },
  );

  // ------------------------------------------------------------ alerts
  typed.get(
    '/api/v1/admin/alerts',
    {
      schema: {
        tags: ['admin'],
        summary: 'Açıq sistem xəbərdarlıqları (məs. mənbə 24 saatdır yenilənmir)',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.array(
            z.object({
              id: z.uuid(),
              kind: z.string(),
              sourceId: z.uuid().nullable(),
              message: z.string(),
              createdAt: z.string(),
            }),
          ),
          ...errorResponses(401, 403),
        },
      },
      config: { permission: PERMISSIONS.ADMIN_HEALTH },
    },
    async () =>
      (await ing().openAlerts()).map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
  );
}
