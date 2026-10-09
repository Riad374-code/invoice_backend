import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { auditRequest } from '../audit/http.js';
import { createRepos } from '../db/index.js';
import {
  EXTRACTION_STATUSES,
  PERMISSIONS,
  normalizeFolder,
  normalizeTags,
  sanitizeFileName,
  transitionExtraction,
  type FileExtraction,
  type FileRecord,
  type FileVersion,
} from '../domain/index.js';
import { ApiError, errorResponses } from '../error.js';
import { QUEUES } from '../jobs/types.js';
import { requireAuth } from '../plugins/auth.js';
import { ingestUpload, validated } from '../files/upload.js';
import { StorageError } from '../storage/index.js';

const ExtractionStatusSchema = z.enum(EXTRACTION_STATUSES);

const FileSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int(),
  folder: z.string(),
  tags: z.array(z.string()),
  ownerId: z.uuid(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  extractionStatus: ExtractionStatusSchema.nullable(),
});

const VersionSchema = z.object({
  id: z.uuid(),
  versionNo: z.number().int(),
  sha256: z.string(),
  size: z.number().int(),
  mime: z.string(),
  uploadedBy: z.uuid(),
  createdAt: z.string(),
});

const ExtractionSchema = z.object({
  status: ExtractionStatusSchema,
  detectedKind: z.string().nullable(),
  error: z.string().nullable(),
  textLength: z.number().int().nullable(),
  updatedAt: z.string(),
});

const FileDetailSchema = FileSchema.extend({
  versions: z.array(VersionSchema),
  extraction: ExtractionSchema.nullable(),
});

const toFileResponse = (f: FileRecord, extractionStatus: FileExtraction['status'] | null) => ({
  id: f.id,
  name: f.name,
  mime: f.mime,
  size: f.size,
  folder: f.folder,
  tags: f.tags,
  ownerId: f.ownerId,
  archivedAt: f.archivedAt?.toISOString() ?? null,
  createdAt: f.createdAt.toISOString(),
  updatedAt: f.updatedAt.toISOString(),
  extractionStatus,
});

const toVersionResponse = (v: FileVersion) => ({
  id: v.id,
  versionNo: v.versionNo,
  sha256: v.sha256,
  size: v.size,
  mime: v.mime,
  uploadedBy: v.uploadedBy,
  createdAt: v.createdAt.toISOString(),
});

const toExtractionResponse = (e: FileExtraction) => ({
  status: e.status,
  detectedKind: e.detectedKind,
  error: e.error,
  textLength: e.text === null ? null : e.text.length,
  updatedAt: e.updatedAt.toISOString(),
});

const IdParams = z.object({ id: z.uuid() });

function encodeCursor(f: FileRecord): string {
  return Buffer.from(JSON.stringify({ t: f.createdAt.toISOString(), i: f.id })).toString(
    'base64url',
  );
}
function decodeCursor(raw: string): { createdAt: Date; id: string } {
  try {
    const { t, i } = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      t: string;
      i: string;
    };
    const createdAt = new Date(t);
    if (Number.isNaN(createdAt.getTime()) || !z.uuid().safeParse(i).success) throw new Error('bad');
    return { createdAt, id: i };
  } catch {
    throw ApiError.validation('Invalid cursor');
  }
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export default async function fileRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { config } = app.ctx;

  async function loadFile(companyId: string, id: string): Promise<FileRecord> {
    const file = await app.ctx.repos.files.findById(companyId, id);
    if (!file) throw ApiError.notFound(`File ${id} not found`);
    return file;
  }

  // ------------------------------------------------------------- POST /files
  typed.post(
    '/api/v1/files',
    {
      schema: {
        tags: ['files'],
        summary: 'Fayl yüklə (multipart/form-data: file, folder?, tags?, name?)',
        description:
          'Ölçü limiti, magic-byte MIME yoxlaması və antivirus skanı keçən fayl S3-ə yazılır (sha256 ilə dedupe), ' +
          'versiya və extraction (pending) yaradılır, `file.extract` işi növbələnir.',
        consumes: ['multipart/form-data'],
        security: [{ bearerAuth: [] }],
        response: { 201: FileDetailSchema, ...errorResponses(401, 403, 413, 422, 503) },
      },
      config: { permission: PERMISSIONS.FILES_WRITE },
    },
    async (request, reply) => {
      const { file, version, extraction } = await ingestUpload(app, request);

      void reply.status(201);
      return {
        ...toFileResponse(file, extraction.status),
        versions: [toVersionResponse(version)],
        extraction: toExtractionResponse(extraction),
      };
    },
  );

  // -------------------------------------------------------------- GET /files
  typed.get(
    '/api/v1/files',
    {
      schema: {
        tags: ['files'],
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          folder: z.string().max(500).optional(),
          tag: z.string().max(50).optional(),
          q: z.string().max(255).optional(),
          includeArchived: z.stringbool().default(false),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          cursor: z.string().max(300).optional(),
        }),
        response: {
          200: z.object({ items: z.array(FileSchema), nextCursor: z.string().nullable() }),
          ...errorResponses(401, 403, 422),
        },
      },
      config: { permission: PERMISSIONS.FILES_READ },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { folder, tag, q, includeArchived, limit, cursor } = request.query;
      const rows = await app.ctx.repos.files.list({
        companyId: auth.companyId,
        folder: folder === undefined ? undefined : validated(() => normalizeFolder(folder)),
        tag,
        q,
        includeArchived,
        limit,
        cursor: cursor ? decodeCursor(cursor) : undefined,
      });
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const statuses = await app.ctx.repos.files.latestExtractionStatuses(
        auth.companyId,
        page.map((f) => f.id),
      );
      return {
        items: page.map((f) => toFileResponse(f, statuses.get(f.id) ?? null)),
        nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
      };
    },
  );

  // ---------------------------------------------------------- GET /files/:id
  typed.get(
    '/api/v1/files/:id',
    {
      schema: {
        tags: ['files'],
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: { 200: FileDetailSchema, ...errorResponses(401, 403, 404, 422) },
      },
      config: { permission: PERMISSIONS.FILES_READ },
    },
    async (request) => {
      const auth = requireAuth(request);
      const file = await loadFile(auth.companyId, request.params.id);
      const versions = await app.ctx.repos.files.listVersions(auth.companyId, file.id);
      const latest = versions[0];
      const extraction = latest
        ? await app.ctx.repos.files.findExtraction(auth.companyId, latest.id)
        : null;
      return {
        ...toFileResponse(file, extraction?.status ?? null),
        versions: versions.map(toVersionResponse),
        extraction: extraction ? toExtractionResponse(extraction) : null,
      };
    },
  );

  // ------------------------------------------------- GET /files/:id/content
  typed.get(
    '/api/v1/files/:id/content',
    {
      schema: {
        tags: ['files'],
        summary: 'Faylın cari versiyasının məzmunu (attachment)',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: errorResponses(401, 403, 404, 422, 503),
      },
      config: { permission: PERMISSIONS.FILES_READ },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const file = await loadFile(auth.companyId, request.params.id);
      const version = await app.ctx.repos.files.latestVersion(auth.companyId, file.id);
      if (!version) throw ApiError.notFound('File has no versions');
      try {
        const stream = await app.ctx.storage.getStream(version.storageKey);
        return (
          reply
            .header('content-type', version.mime)
            .header('content-length', version.size)
            .header('content-disposition', contentDisposition(file.name))
            // brauzer məzmunu "təxmin edib" icra etməsin
            .header('x-content-type-options', 'nosniff')
            .header('cache-control', 'private, no-store')
            .send(stream as never)
        ); // axın: serializer işləmir
      } catch (err) {
        if (err instanceof StorageError) {
          request.log.error({ err }, 'object storage failure');
          throw err.kind === 'NOT_FOUND'
            ? ApiError.internal('Stored object is missing')
            : ApiError.upstream('Object storage is unavailable');
        }
        throw err;
      }
    },
  );

  // -------------------------------------------------------- PATCH /files/:id
  typed.patch(
    '/api/v1/files/:id',
    {
      schema: {
        tags: ['files'],
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: z
          .object({
            name: z.string().min(1).max(255).optional(),
            folder: z.string().max(500).optional(),
            tags: z.array(z.string().max(50)).max(20).optional(),
          })
          .refine((b) => b.name !== undefined || b.folder !== undefined || b.tags !== undefined, {
            message: 'Provide at least one of name, folder, tags',
          }),
        response: { 200: FileSchema, ...errorResponses(401, 403, 404, 409, 422) },
      },
      config: { permission: PERMISSIONS.FILES_WRITE },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { id } = request.params;
      const patch = {
        ...(request.body.name !== undefined && {
          name: validated(() => sanitizeFileName(request.body.name!)),
        }),
        ...(request.body.folder !== undefined && {
          folder: validated(() => normalizeFolder(request.body.folder)),
        }),
        ...(request.body.tags !== undefined && {
          tags: validated(() => normalizeTags(request.body.tags!)),
        }),
      };

      return app.ctx.db.tx(async (tx) => {
        const repos = createRepos(tx);
        const before = await loadFileWith(repos, auth.companyId, id);
        if (before.archivedAt) throw ApiError.conflict('Archived files cannot be edited');
        const updated = await repos.files.update(auth.companyId, id, patch, new Date());
        if (!updated) throw ApiError.notFound(`File ${id} not found`);
        await auditRequest(
          app,
          request,
          {
            action: 'file.update',
            resourceType: 'file',
            resourceId: id,
            before: { name: before.name, folder: before.folder, tags: before.tags },
            after: { name: updated.name, folder: updated.folder, tags: updated.tags },
          },
          tx,
        );
        const status =
          (await repos.files.latestExtractionStatuses(auth.companyId, [id])).get(id) ?? null;
        return toFileResponse(updated, status);
      });
    },
  );

  async function loadFileWith(
    repos: ReturnType<typeof createRepos>,
    companyId: string,
    id: string,
  ) {
    const file = await repos.files.findById(companyId, id);
    if (!file) throw ApiError.notFound(`File ${id} not found`);
    return file;
  }

  // ------------------------------------------------- POST /files/:id/archive
  typed.post(
    '/api/v1/files/:id/archive',
    {
      schema: {
        tags: ['files'],
        summary: 'Faylı arxivləşdir (idempotent; silmə yoxdur)',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: { 200: FileSchema, ...errorResponses(401, 403, 404, 422) },
      },
      config: { permission: PERMISSIONS.FILES_WRITE },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { id } = request.params;
      return app.ctx.db.tx(async (tx) => {
        const repos = createRepos(tx);
        const before = await loadFileWith(repos, auth.companyId, id);
        const archived = await repos.files.archive(auth.companyId, id, new Date());
        if (!archived) throw ApiError.notFound(`File ${id} not found`);
        await auditRequest(
          app,
          request,
          {
            action: 'file.archive',
            resourceType: 'file',
            resourceId: id,
            before: { archivedAt: before.archivedAt?.toISOString() ?? null },
            after: { archivedAt: archived.archivedAt?.toISOString() ?? null },
          },
          tx,
        );
        const status =
          (await repos.files.latestExtractionStatuses(auth.companyId, [id])).get(id) ?? null;
        return toFileResponse(archived, status);
      });
    },
  );

  // ------------------------------------------------- POST /files/:id/restore
  typed.post(
    '/api/v1/files/:id/restore',
    {
      schema: {
        tags: ['files'],
        summary: 'Arxivlənmiş faylı bərpa et (idempotent)',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: { 200: FileSchema, ...errorResponses(401, 403, 404, 422) },
      },
      config: { permission: PERMISSIONS.FILES_WRITE },
    },
    async (request) => {
      const auth = requireAuth(request);
      const { id } = request.params;
      return app.ctx.db.tx(async (tx) => {
        const repos = createRepos(tx);
        const before = await loadFileWith(repos, auth.companyId, id);
        const restored = await repos.files.restore(auth.companyId, id, new Date());
        if (!restored) throw ApiError.notFound(`File ${id} not found`);
        await auditRequest(
          app,
          request,
          {
            action: 'file.restore',
            resourceType: 'file',
            resourceId: id,
            before: { archivedAt: before.archivedAt?.toISOString() ?? null },
            after: { archivedAt: null },
          },
          tx,
        );
        const status =
          (await repos.files.latestExtractionStatuses(auth.companyId, [id])).get(id) ?? null;
        return toFileResponse(restored, status);
      });
    },
  );

  // ------------------------------------------------- POST /files/:id/reindex
  typed.post(
    '/api/v1/files/:id/reindex',
    {
      schema: {
        tags: ['files'],
        summary: 'Cari versiyanın extraction-unu yenidən işə sal',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: { 202: ExtractionSchema, ...errorResponses(401, 403, 404, 409, 422) },
      },
      config: { permission: PERMISSIONS.FILES_WRITE },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const { id } = request.params;
      const result = await app.ctx.db.tx(async (tx) => {
        const repos = createRepos(tx);
        const file = await loadFileWith(repos, auth.companyId, id);
        if (file.archivedAt) throw ApiError.conflict('Archived files cannot be reindexed');
        const version = await repos.files.latestVersion(auth.companyId, id);
        if (!version) throw ApiError.notFound('File has no versions');
        const current = await repos.files.findExtraction(auth.companyId, version.id, {
          forUpdate: true,
        });
        if (!current) throw ApiError.internal('Extraction row is missing');

        // artıq növbədə: təkrar iş yaratma (idempotent)
        if (current.status === 'pending') return current;
        if (current.status === 'extracting')
          throw ApiError.conflict('Extraction is already running');

        const now = new Date();
        const next: FileExtraction = {
          ...current,
          status: transitionExtraction(current.status, 'pending'),
          error: null,
          updatedAt: now,
        };
        await repos.files.saveExtraction(next);
        await repos.jobs.enqueue(
          {
            queue: QUEUES.FILE_EXTRACT,
            companyId: auth.companyId,
            payload: { fileVersionId: version.id },
            idempotencyKey: `reindex:${version.id}:${now.getTime()}`,
          },
          now,
        );
        await auditRequest(
          app,
          request,
          {
            action: 'file.reindex',
            resourceType: 'file',
            resourceId: id,
            before: { extractionStatus: current.status },
            after: { extractionStatus: next.status, fileVersionId: version.id },
          },
          tx,
        );
        return next;
      });
      void reply.status(202);
      return toExtractionResponse(result);
    },
  );

  void config;
}

export type { FastifyRequest };
