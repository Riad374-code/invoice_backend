import { Cron } from 'croner';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { D, TAX_TYPES, assertLocalDate } from '../accounting/index.js';
import { auditRequest } from '../audit/http.js';
import { createRepos } from '../db/index.js';
import {
  PERMISSIONS,
  newApproval,
  transitionUserStatus,
  DomainError,
  type UserStatus,
} from '../domain/index.js';
import { ApiError, errorResponses } from '../error.js';
import { sameSite } from '../ingestion/url.js';
import { requireAuth } from '../plugins/auth.js';
import { hashPassword } from '../security/index.js';
import { UpstreamError } from '../rag/clients.js';

const Day = z.string().refine((d) => {
  try {
    assertLocalDate(d);
    return true;
  } catch {
    return false;
  }
}, 'must be YYYY-MM-DD');
const IdParams = z.object({ id: z.uuid() });
const Password = z.string().min(12).max(128);

const MODEL_NEXT: Record<string, readonly string[]> = {
  candidate: ['canary', 'retired'],
  canary: ['production', 'candidate', 'retired'],
  production: ['retired'],
  retired: [],
};

const HtmlDoc = z.object({
  content: z.string().min(1),
  title: z.string().optional(),
  remove: z.array(z.string()).optional(),
});
const SourceConfig = {
  rss: z.object({ feedUrl: z.url().optional(), article: HtmlDoc.optional() }).strict(),
  html_list: z
    .object({
      list: z.object({
        item: z.string().min(1),
        link: z.string().min(1),
        title: z.string().optional(),
        date: z.string().optional(),
      }),
      article: HtmlDoc.optional(),
    })
    .strict(),
  html_document: z
    .object({
      documents: z
        .array(
          z
            .object({
              url: z.url(),
              type: z.enum(['code', 'law', 'decree', 'cabinet_decision', 'standard']),
              officialNumber: z.string().optional(),
              adoptedAt: Day.optional(),
              title: z.string().optional(),
              language: z.string().max(5).optional(),
              content: HtmlDoc,
              initialValidFrom: Day.optional(),
            })
            .strict(),
        )
        .min(1)
        .max(200),
    })
    .strict(),
} as const;

export default async function adminConsoleRoutes(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  /** Qlobal məlumat (mənbələr, vergi dərəcələri, modellər) yalnız platforma operatoru şirkətinin `platform:admin` sahibinə açıqdır. */
  async function requirePlatform(request: FastifyRequest) {
    const auth = requireAuth(request);
    const company = await app.ctx.repos.companies.findById(auth.companyId);
    if (
      !auth.permissions.includes(PERMISSIONS.PLATFORM_ADMIN) ||
      !(await app.ctx.repos.impact.platformCompanyId().then((id) => id === auth.companyId)) ||
      !company
    ) {
      throw ApiError.forbidden('This operation is reserved for platform operators');
    }
    return auth;
  }

  // ------------------------------------------------------------------ users
  const UserSchema = z.object({
    id: z.uuid(),
    email: z.string(),
    status: z.enum(['pending', 'active', 'suspended']),
    roles: z.array(z.string()),
    createdAt: z.string(),
  });
  typed.get(
    '/api/v1/admin/users',
    {
      schema: {
        tags: ['admin'],
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(UserSchema), ...errorResponses(401, 403) },
      },
      config: { permission: PERMISSIONS.USERS_READ },
    },
    async (request) =>
      (await app.ctx.repos.admin.listUsers(requireAuth(request).companyId)).map((u) => ({
        ...u,
        status: u.status as UserStatus,
        createdAt: u.createdAt.toISOString(),
      })),
  );

  /** Rolların bütün icazələri çağıranın öz icazələrinin alt çoxluğu olmalıdır (imtiyaz yüksəltmə qarşısı). */
  async function assertCanGrant(
    auth: { permissions: string[]; companyId: string },
    roleIds: string[],
  ) {
    const roles = (await app.ctx.repos.admin.listRoles(auth.companyId)).filter((r) =>
      roleIds.includes(r.id),
    );
    if (roles.length !== new Set(roleIds).size) throw ApiError.validation('Unknown role');
    for (const r of roles)
      for (const p of r.permissions)
        if (!auth.permissions.includes(p))
          throw ApiError.forbidden(
            `Cannot grant role "${r.name}": it contains permission "${p}" you do not hold`,
          );
    return roles;
  }

  typed.post(
    '/api/v1/admin/users',
    {
      schema: {
        tags: ['admin'],
        security: [{ bearerAuth: [] }],
        body: z.object({
          email: z.email().max(255),
          password: Password,
          roleIds: z.array(z.uuid()).min(1).max(10),
        }),
        response: { 201: UserSchema, ...errorResponses(401, 403, 409, 422) },
      },
      config: { permission: PERMISSIONS.USERS_WRITE },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const email = request.body.email.toLowerCase();
      if (request.body.password.toLowerCase().includes(email.split('@')[0]!))
        throw ApiError.validation('Password must not contain the e-mail name');
      await assertCanGrant(auth, request.body.roleIds);
      const passwordHash = await hashPassword(request.body.password);
      const id = await app.ctx.db.tx(async (tx) => {
        const r = createRepos(tx);
        const now = new Date();
        const user = await r.users.create({
          id: randomUUID(),
          companyId: auth.companyId,
          email,
          passwordHash,
          status: 'active',
          mfaSecret: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
        await r.admin.setUserRoles(user.id, request.body.roleIds);
        await auditRequest(
          app,
          request,
          {
            action: 'user.create',
            resourceType: 'user',
            resourceId: user.id,
            after: { email, roleIds: request.body.roleIds },
          },
          tx,
        );
        return user.id;
      });
      void reply.status(201);
      const u = (await app.ctx.repos.admin.listUsers(auth.companyId)).find((x) => x.id === id)!;
      return { ...u, status: u.status as UserStatus, createdAt: u.createdAt.toISOString() };
    },
  );

  typed.patch(
    '/api/v1/admin/users/:id',
    {
      schema: {
        tags: ['admin'],
        summary:
          'İstifadəçi statusu (state machine); özünü və son admini dayandırmaq olmaz; sessiyalar ləğv olunur',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: z.object({ status: z.enum(['active', 'suspended']) }),
        response: { 200: UserSchema, ...errorResponses(401, 403, 404, 409, 422) },
      },
      config: { permission: PERMISSIONS.USERS_WRITE },
    },
    async (request) => {
      const auth = requireAuth(request);
      await app.ctx.db.tx(async (tx) => {
        const r = createRepos(tx);
        const user = await r.users.findById(request.params.id);
        if (!user || user.companyId !== auth.companyId) throw ApiError.notFound('User not found');
        if (user.id === auth.userId && request.body.status === 'suspended')
          throw ApiError.conflict('You cannot suspend yourself');
        let next: UserStatus;
        try {
          next = transitionUserStatus(user.status, request.body.status);
        } catch (e) {
          if (e instanceof DomainError) throw ApiError.conflict(e.message);
          throw e;
        }
        if (
          next === 'suspended' &&
          (await r.admin.activeAdminCount(auth.companyId, user.id)) === 0 &&
          (await r.roles.getUserRoles(user.id)).some((x) => x.name === 'admin')
        )
          throw ApiError.conflict('Cannot suspend the last active admin');
        await r.users.updateStatus(user.id, next);
        if (next === 'suspended') await r.sessions.revokeAllForUser(user.id, new Date());
        await auditRequest(
          app,
          request,
          {
            action: 'user.status',
            resourceType: 'user',
            resourceId: user.id,
            before: { status: user.status },
            after: { status: next },
          },
          tx,
        );
      });
      const u = (await app.ctx.repos.admin.listUsers(auth.companyId)).find(
        (x) => x.id === request.params.id,
      )!;
      return { ...u, status: u.status as UserStatus, createdAt: u.createdAt.toISOString() };
    },
  );

  typed.put(
    '/api/v1/admin/users/:id/roles',
    {
      schema: {
        tags: ['admin'],
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: z.object({ roleIds: z.array(z.uuid()).min(1).max(10) }),
        response: { 200: UserSchema, ...errorResponses(401, 403, 404, 409, 422) },
      },
      config: { permission: PERMISSIONS.USERS_WRITE },
    },
    async (request) => {
      const auth = requireAuth(request);
      const roles = await assertCanGrant(auth, request.body.roleIds);
      await app.ctx.db.tx(async (tx) => {
        const r = createRepos(tx);
        const user = await r.users.findById(request.params.id);
        if (!user || user.companyId !== auth.companyId) throw ApiError.notFound('User not found');
        const before = (await r.roles.getUserRoles(user.id)).map((x) => x.name);
        if (
          before.includes('admin') &&
          !roles.some((x) => x.name === 'admin') &&
          user.status === 'active' &&
          (await r.admin.activeAdminCount(auth.companyId, user.id)) === 0
        )
          throw ApiError.conflict('Cannot remove admin from the last active admin');
        await r.admin.setUserRoles(user.id, request.body.roleIds);
        await auditRequest(
          app,
          request,
          {
            action: 'user.roles',
            resourceType: 'user',
            resourceId: user.id,
            before: { roles: before },
            after: { roles: roles.map((x) => x.name) },
          },
          tx,
        );
      });
      const u = (await app.ctx.repos.admin.listUsers(auth.companyId)).find(
        (x) => x.id === request.params.id,
      )!;
      return { ...u, status: u.status as UserStatus, createdAt: u.createdAt.toISOString() };
    },
  );

  // ------------------------------------------------------------------ roles
  const RoleSchema = z.object({
    id: z.uuid(),
    name: z.string(),
    system: z.boolean(),
    description: z.string().nullable(),
    permissions: z.array(z.string()),
  });
  typed.get(
    '/api/v1/admin/roles',
    {
      schema: {
        tags: ['admin'],
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(RoleSchema), ...errorResponses(401, 403) },
      },
      config: { permission: PERMISSIONS.ROLES_READ },
    },
    async (request) => app.ctx.repos.admin.listRoles(requireAuth(request).companyId),
  );

  typed.post(
    '/api/v1/admin/roles',
    {
      schema: {
        tags: ['admin'],
        summary: 'Şirkətə məxsus rol yarat (icazələr çağıranın icazələrinin alt çoxluğu olmalıdır)',
        security: [{ bearerAuth: [] }],
        body: z.object({
          name: z.string().trim().min(2).max(60),
          description: z.string().max(300).optional(),
          permissions: z.array(z.string()).max(50),
        }),
        response: { 201: RoleSchema, ...errorResponses(401, 403, 409, 422) },
      },
      config: { permission: PERMISSIONS.ROLES_WRITE },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      const known = await app.ctx.repos.admin.knownPermissionCodes();
      for (const p of request.body.permissions) {
        if (!known.has(p)) throw ApiError.validation(`Unknown permission "${p}"`);
        if (!auth.permissions.includes(p))
          throw ApiError.forbidden(`You cannot grant "${p}" because you do not hold it`);
      }
      const id = await app.ctx.db.tx(async (tx) => {
        const r = createRepos(tx);
        const now = new Date();
        const role = await r.roles.createRole({
          id: randomUUID(),
          companyId: auth.companyId,
          name: request.body.name,
          description: request.body.description ?? null,
          createdAt: now,
          updatedAt: now,
        });
        await r.admin.setRolePermissions(role.id, request.body.permissions);
        await auditRequest(
          app,
          request,
          {
            action: 'role.create',
            resourceType: 'role',
            resourceId: role.id,
            after: { name: role.name, permissions: request.body.permissions },
          },
          tx,
        );
        return role.id;
      });
      void reply.status(201);
      return (await app.ctx.repos.admin.listRoles(auth.companyId)).find((r) => r.id === id)!;
    },
  );

  typed.put(
    '/api/v1/admin/roles/:id/permissions',
    {
      schema: {
        tags: ['admin'],
        summary:
          'Yalnız şirkətin öz (xüsusi) rolları dəyişdirilə bilər; sistem rolları dəyişməzdir',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: z.object({ permissions: z.array(z.string()).max(50) }),
        response: { 200: RoleSchema, ...errorResponses(401, 403, 404, 422) },
      },
      config: { permission: PERMISSIONS.ROLES_WRITE },
    },
    async (request) => {
      const auth = requireAuth(request);
      const role = (await app.ctx.repos.admin.listRoles(auth.companyId)).find(
        (r) => r.id === request.params.id,
      );
      if (!role) throw ApiError.notFound('Role not found');
      if (role.system) throw ApiError.forbidden('System roles cannot be modified');
      const known = await app.ctx.repos.admin.knownPermissionCodes();
      for (const p of request.body.permissions) {
        if (!known.has(p)) throw ApiError.validation(`Unknown permission "${p}"`);
        if (!auth.permissions.includes(p))
          throw ApiError.forbidden(`You cannot grant "${p}" because you do not hold it`);
      }
      await app.ctx.db.tx(async (tx) => {
        await createRepos(tx).admin.setRolePermissions(role.id, request.body.permissions);
        await auditRequest(
          app,
          request,
          {
            action: 'role.permissions',
            resourceType: 'role',
            resourceId: role.id,
            before: { permissions: role.permissions },
            after: { permissions: request.body.permissions },
          },
          tx,
        );
      });
      return (await app.ctx.repos.admin.listRoles(auth.companyId)).find((r) => r.id === role.id)!;
    },
  );

  // ---------------------------------------------------------------- sources
  const SourceSchema = z.object({
    id: z.uuid(),
    name: z.string(),
    url: z.string(),
    type: z.string(),
    kind: z.string(),
    adapter: z.string().nullable(),
    config: z.unknown(),
    fetchCron: z.string(),
    enabled: z.boolean(),
  });
  typed.get(
    '/api/v1/admin/sources',
    {
      schema: {
        tags: ['admin'],
        summary: '[platforma] Mənbələr',
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(SourceSchema), ...errorResponses(401, 403) },
      },
      config: { permission: PERMISSIONS.PLATFORM_ADMIN },
    },
    async (request) => {
      await requirePlatform(request);
      return app.ctx.repos.ingestion.listSources();
    },
  );

  typed.put(
    '/api/v1/admin/sources/:id',
    {
      schema: {
        tags: ['admin'],
        summary:
          '[platforma] Mənbə adapteri/konfiqurasiyası/cron/aktivlik (aktivləşdirmə robots.txt və şərtlərin yoxlanmasından sonra)',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: z
          .object({
            adapter: z.enum(['rss', 'html_list', 'html_document']).optional(),
            config: z.unknown().optional(),
            fetchCron: z.string().max(100).optional(),
            enabled: z.boolean().optional(),
          })
          .refine((b) => Object.keys(b).length > 0, 'Provide at least one field'),
        response: { 200: SourceSchema, ...errorResponses(401, 403, 404, 422) },
      },
      config: { permission: PERMISSIONS.PLATFORM_ADMIN },
    },
    async (request) => {
      await requirePlatform(request);
      const src = await app.ctx.repos.ingestion.getSource(request.params.id);
      if (!src) throw ApiError.notFound('Source not found');
      const adapter = request.body.adapter ?? src.adapter;
      if (request.body.fetchCron) {
        try {
          new Cron(request.body.fetchCron, { paused: true });
        } catch {
          throw ApiError.validation('fetchCron is not a valid cron expression');
        }
      }
      let config = request.body.config;
      if (adapter && (config !== undefined || request.body.adapter)) {
        const parsed = SourceConfig[adapter].safeParse(config ?? src.config);
        if (!parsed.success)
          throw ApiError.validation(
            `config does not match adapter "${adapter}": ${parsed.error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')}`,
          );
        config = parsed.data;
        const urls: string[] = [];
        if (adapter === 'rss' && (parsed.data as { feedUrl?: string }).feedUrl)
          urls.push((parsed.data as { feedUrl: string }).feedUrl);
        if (adapter === 'html_document')
          urls.push(
            ...(parsed.data as { documents: Array<{ url: string }> }).documents.map((d) => d.url),
          );
        for (const u of urls)
          if (!sameSite(u, src.url))
            throw ApiError.validation(`URL ${u} is outside the source site`);
      }
      if (request.body.enabled && !adapter)
        throw ApiError.conflict('Configure an adapter before enabling the source');
      await app.ctx.db.tx(async (tx) => {
        await createRepos(tx).ingestion.updateSource(src.id, {
          adapter: request.body.adapter,
          config,
          enabled: request.body.enabled,
          fetchCron: request.body.fetchCron,
        });
        await auditRequest(
          app,
          request,
          {
            action: 'source.update',
            resourceType: 'source',
            resourceId: src.id,
            before: { adapter: src.adapter, enabled: src.enabled, fetchCron: src.fetchCron },
            after: {
              adapter,
              enabled: request.body.enabled ?? src.enabled,
              fetchCron: request.body.fetchCron ?? src.fetchCron,
            },
          },
          tx,
        );
      });
      return (await app.ctx.repos.ingestion.getSource(src.id))!;
    },
  );

  // -------------------------------------------------------------- tax rates
  const RateSchema = z.object({
    id: z.uuid(),
    taxType: z.string(),
    code: z.string(),
    rate: z.string(),
    treatment: z.string().nullable(),
    validFrom: z.string(),
    validTo: z.string().nullable(),
    legalSourceId: z.uuid().nullable(),
    status: z.string(),
  });
  typed.get(
    '/api/v1/admin/tax-rates',
    {
      schema: {
        tags: ['admin'],
        summary: '[platforma] Bütün dərəcələr (proposed daxil)',
        security: [{ bearerAuth: [] }],
        response: { 200: z.array(RateSchema), ...errorResponses(401, 403) },
      },
      config: { permission: PERMISSIONS.PLATFORM_ADMIN },
    },
    async (request) => {
      await requirePlatform(request);
      return app.ctx.repos.admin.allTaxRates();
    },
  );

  typed.post(
    '/api/v1/admin/tax-rates',
    {
      schema: {
        tags: ['admin'],
        summary:
          '[platforma] Dərəcə təklifi (status = proposed; aktivləşmə ayrıca təsdiq tələb edir)',
        security: [{ bearerAuth: [] }],
        body: z.object({
          taxType: z.enum(TAX_TYPES),
          code: z.string().trim().min(1).max(60),
          ratePercent: z.string().regex(/^\d+(\.\d{1,4})?$/),
          treatment: z.enum(['taxable', 'zero_rated', 'exempt']).optional(),
          validFrom: Day,
          validTo: Day.optional(),
          legalSourceId: z.uuid().optional(),
        }),
        response: { 201: RateSchema, ...errorResponses(401, 403, 409, 422) },
      },
      config: { permission: PERMISSIONS.PLATFORM_ADMIN },
    },
    async (request, reply) => {
      await requirePlatform(request);
      const b = request.body;
      if (new D(b.ratePercent).gt(100)) throw ApiError.validation('ratePercent must be 0..100');
      if (b.validTo && b.validTo < b.validFrom)
        throw ApiError.validation('validTo must not precede validFrom');
      if (await app.ctx.repos.impact.rateExists(b.taxType, b.code, b.validFrom))
        throw ApiError.conflict('A rate with this type, code and start date already exists');
      const rate = await app.ctx.db.tx(async (tx) => {
        const created = await createRepos(tx).taxRates.create({
          taxType: b.taxType,
          code: b.code,
          ratePercent: new D(b.ratePercent),
          validFrom: b.validFrom,
          validTo: b.validTo ?? null,
          legalSourceId: b.legalSourceId ?? null,
          status: 'proposed',
          treatment: b.treatment ?? null,
        });
        await auditRequest(
          app,
          request,
          {
            action: 'tax_rate.propose',
            resourceType: 'tax_rate',
            resourceId: created.id,
            after: b,
          },
          tx,
        );
        return created;
      });
      void reply.status(201);
      return (await app.ctx.repos.admin.allTaxRates()).find((r) => r.id === rate.id)!;
    },
  );

  typed.post(
    '/api/v1/admin/tax-rates/:id/request-activation',
    {
      schema: {
        tags: ['admin'],
        summary:
          '[platforma] Təklifi aktivləşdirmək üçün təsdiq sorğusu (başqa operator təsdiqləməlidir)',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        response: {
          202: z.object({ approvalId: z.uuid(), status: z.literal('approval_required') }),
          ...errorResponses(401, 403, 404, 409, 422),
        },
      },
      config: { permission: PERMISSIONS.PLATFORM_ADMIN },
    },
    async (request, reply) => {
      const auth = await requirePlatform(request);
      const rate = await app.ctx.repos.impact.findRate(request.params.id);
      if (!rate) throw ApiError.notFound('Tax rate not found');
      if (rate.status !== 'proposed')
        throw ApiError.conflict('Only proposed rates can be activated');
      const open = (await app.ctx.repos.approvals.listByCompany(auth.companyId)).find(
        (a) =>
          a.kind === 'tax_rate_proposal' &&
          a.status === 'pending' &&
          (a.payload as { taxRateId?: string })?.taxRateId === rate.id,
      );
      const approval =
        open ??
        (await app.ctx.db.tx(async (tx) => {
          const a = await createRepos(tx).approvals.create(
            newApproval({
              companyId: auth.companyId,
              kind: 'tax_rate_proposal',
              resourceRef: `tax_rate:${rate.id}`,
              requesterId: auth.userId,
              payload: {
                taxRateId: rate.id,
                taxType: rate.taxType,
                code: rate.code,
                validFrom: rate.validFrom,
                requestedBy: 'admin',
              },
              expiresAt: new Date(Date.now() + 14 * 86_400_000),
            }),
          );
          await auditRequest(
            app,
            request,
            {
              action: 'tax_rate.request_activation',
              resourceType: 'tax_rate',
              resourceId: rate.id,
              after: { approvalId: a.id },
            },
            tx,
          );
          return a;
        }));
      if (open) request.auditRecorded = true;
      void reply.status(202);
      return { approvalId: approval.id, status: 'approval_required' as const };
    },
  );

  // ----------------------------------------------------------------- models
  const ModelSchema = z.object({
    id: z.uuid(),
    name: z.string(),
    version: z.string(),
    kind: z.enum(['llm', 'embedding', 'classifier']),
    artifactUri: z.string(),
    status: z.enum(['candidate', 'canary', 'production', 'retired']),
    evalReport: z.unknown(),
    createdAt: z.string(),
  });
  const model = (m: Awaited<ReturnType<typeof app.ctx.repos.admin.listModels>>[number]) => ({
    ...m,
    createdAt: m.createdAt.toISOString(),
  });
  typed.get(
    '/api/v1/admin/models',
    {
      schema: {
        tags: ['admin'],
        summary: '[platforma] Model versiyaları + model-serving-in bildirdiyi aktiv modellər',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            versions: z.array(ModelSchema),
            serving: z.object({
              available: z.boolean(),
              models: z.array(z.string()),
              error: z.string().nullable(),
            }),
          }),
          ...errorResponses(401, 403),
        },
      },
      config: { permission: PERMISSIONS.PLATFORM_ADMIN },
    },
    async (request) => {
      await requirePlatform(request);
      let serving = {
        available: false,
        models: [] as string[],
        error: 'model-serving is not configured' as string | null,
      };
      if (app.ctx.models?.listModels) {
        try {
          serving = {
            available: true,
            models: (await app.ctx.models.listModels()).map((m) => m.id),
            error: null,
          };
        } catch (e) {
          serving = {
            available: false,
            models: [],
            error: e instanceof UpstreamError ? e.message : 'invalid response',
          };
        }
      }
      return { versions: (await app.ctx.repos.admin.listModels()).map(model), serving };
    },
  );

  typed.post(
    '/api/v1/admin/models',
    {
      schema: {
        tags: ['admin'],
        security: [{ bearerAuth: [] }],
        body: z.object({
          name: z.string().trim().min(1).max(100),
          version: z.string().trim().min(1).max(50),
          kind: z.enum(['llm', 'embedding', 'classifier']),
          artifactUri: z.string().min(3).max(500),
          evalReport: z.record(z.string(), z.unknown()).optional(),
        }),
        response: { 201: ModelSchema, ...errorResponses(401, 403, 409, 422) },
      },
      config: { permission: PERMISSIONS.PLATFORM_ADMIN },
    },
    async (request, reply) => {
      const auth = await requirePlatform(request);
      const m = await app.ctx.db.tx(async (tx) => {
        const created = await createRepos(tx).admin.createModel({
          ...request.body,
          evalReport: request.body.evalReport ?? null,
          userId: auth.userId,
        });
        await auditRequest(
          app,
          request,
          {
            action: 'model.register',
            resourceType: 'model_version',
            resourceId: created.id,
            after: { name: created.name, version: created.version, kind: created.kind },
          },
          tx,
        );
        return created;
      });
      void reply.status(201);
      return model(m);
    },
  );

  typed.put(
    '/api/v1/admin/models/:id/status',
    {
      schema: {
        tags: ['admin'],
        summary:
          '[platforma] candidate → canary → production → retired. production-a keçid üçün eval_report məcburidir; əvvəlki production avtomatik retired olur',
        security: [{ bearerAuth: [] }],
        params: IdParams,
        body: z.object({ status: z.enum(['candidate', 'canary', 'production', 'retired']) }),
        response: { 200: ModelSchema, ...errorResponses(401, 403, 404, 409, 422) },
      },
      config: { permission: PERMISSIONS.PLATFORM_ADMIN },
    },
    async (request) => {
      await requirePlatform(request);
      const out = await app.ctx.db.tx(async (tx) => {
        const r = createRepos(tx);
        const m = await r.admin.getModel(request.params.id, { forUpdate: true });
        if (!m) throw ApiError.notFound('Model version not found');
        const to = request.body.status;
        if (!MODEL_NEXT[m.status]!.includes(to))
          throw ApiError.conflict(`Cannot move a model from ${m.status} to ${to}`);
        if (to === 'production' && !m.evalReport)
          throw ApiError.conflict('An eval_report is required before promoting to production');
        if (to === 'production') await r.admin.retireProduction(m.kind, m.id);
        await r.admin.setModelStatus(m.id, to);
        await auditRequest(
          app,
          request,
          {
            action: 'model.status',
            resourceType: 'model_version',
            resourceId: m.id,
            before: { status: m.status },
            after: { status: to },
          },
          tx,
        );
        return (await r.admin.getModel(m.id))!;
      });
      return model(out);
    },
  );
}
