import { createHash } from 'node:crypto';
import { maskJsonValue } from '../audit/pii.js';
import type { Repos } from '../db/index.js';
import { newApproval } from '../domain/index.js';
import { ToolRegistry, type ToolContext, type ToolDef } from './tools.js';

export type GatewayStatus = 'succeeded' | 'rejected' | 'approval_required' | 'failed';
export type RejectReason =
  | 'unknown_tool'
  | 'unavailable'
  | 'invalid_arguments'
  | 'forbidden'
  | 'approval_rejected'
  | 'duplicate_call_limit';

export interface GatewayOutcome {
  status: GatewayStatus;
  toolRunId: string;
  /** LLM-ə qaytarılan mətn (JSON). İçində daxili xəta detalı yoxdur. */
  content: string;
  summary: string;
  rejectReason?: RejectReason;
  approvalId?: string;
  reused?: boolean;
}

export const MAX_RESULT_CHARS = 24_000;
const APPROVAL_TTL_MS = 24 * 3_600_000;

/** Eyni (alət + arqumentlər + söhbət) üçün sabit açar: təkrar çağırış ikinci təsdiq/icra yaratmasın. */
export function idempotencyKeyFor(
  conversationId: string | null,
  tool: string,
  args: unknown,
): string {
  return createHash('sha256')
    .update(JSON.stringify([conversationId, tool, canonical(args)]))
    .digest('hex')
    .slice(0, 40);
}
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, canonical(x)]),
    );
  return v;
}

const json = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s.length > MAX_RESULT_CHARS
    ? JSON.stringify({ truncated: true, preview: s.slice(0, MAX_RESULT_CHARS) })
    : s;
};
const reject = (reason: RejectReason, message: string) => ({ error: reason, message });

/**
 * Tool Gateway — model yalnız TƏKLİF edir, server yoxlayıb icra edir (BACKEND.md §10.1):
 *  1 reyestr · 2 JSON Schema validasiya · 3 company_id sessiyadan · 4 icazə · 5 risk (write → təsdiq) · 6 idempotency · 7 tool_runs (həmişə)
 */
export class ToolGateway {
  constructor(private readonly registry: ToolRegistry) {}

  async execute(
    ctx: ToolContext,
    call: { wireName: string; rawArguments: string },
  ): Promise<GatewayOutcome> {
    const started = Date.now();
    const toolName = ToolRegistry.fromWireName(call.wireName);
    let parsedRaw: unknown = null;
    try {
      parsedRaw = JSON.parse(call.rawArguments || '{}');
    } catch {
      /* aşağıda invalid_arguments */
    }
    // 7: sətir həmişə yaradılır (rədd edilsə də); xam arqumentlər PII maskalanmış saxlanır
    const runId = await ctx.repos.assistant.startToolRun({
      companyId: ctx.companyId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      toolName: toolName.slice(0, 100),
      requestedArgs:
        parsedRaw === null
          ? { unparsable: call.rawArguments.slice(0, 500) }
          : maskJsonValue(parsedRaw),
      requestId: ctx.requestId,
    });
    const finish = async (
      o: Omit<GatewayOutcome, 'toolRunId'>,
      extra: {
        validatedArgs?: unknown;
        error?: string;
        idempotencyKey?: string;
        approvalId?: string;
      } = {},
    ): Promise<GatewayOutcome> => {
      await ctx.repos.assistant.finishToolRun(runId, {
        status: o.status,
        validatedArgs:
          extra.validatedArgs === undefined ? null : maskJsonValue(extra.validatedArgs),
        rejectReason: o.rejectReason ?? null,
        error: extra.error ?? null,
        resultSummary: o.summary,
        approvalId: extra.approvalId ?? null, // təkrar çağırışın sətri eyni təsdiqə bağlanmır (unikal indeks)
        durationMs: Date.now() - started,
        idempotencyKey: extra.idempotencyKey ?? null,
      });
      return { ...o, toolRunId: runId };
    };
    const rejected = (
      reason: RejectReason,
      message: string,
      extra: { error?: string; validatedArgs?: unknown } = {},
    ) =>
      finish(
        {
          status: 'rejected',
          rejectReason: reason,
          content: json(reject(reason, message)),
          summary: `${reason}: ${message}`,
        },
        extra,
      );

    // 1. reyestr
    const tool = this.registry.get(toolName) as ToolDef<unknown> | undefined;
    if (!tool) return rejected('unknown_tool', `Tool "${toolName}" does not exist.`);
    if (!tool.available) return rejected('unavailable', `Tool "${toolName}" is not available yet.`);

    // 2. arqumentlərin sxemlə (strict) validasiyası — modelin əlavə etdiyi companyId/userId kimi sahələr burada rədd olur
    if (parsedRaw === null || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw))
      return rejected('invalid_arguments', 'Arguments must be a JSON object.');
    const parsed = tool.args.safeParse(parsedRaw);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
        .join('; ');
      return rejected('invalid_arguments', msg);
    }
    const args = parsed.data;

    // 3. company_id / user_id yalnız ctx-dən (sessiya) — alətə arqument kimi heç vaxt verilmir

    // 4. icazə
    if (!ctx.permissions.includes(tool.permission))
      return rejected('forbidden', `You do not have permission for "${toolName}".`, {
        validatedArgs: args,
      });

    // 6. idempotency: eyni çağırış artıq uğurla icra olunub / təsdiq gözləyirsə təkrar icra/təsdiq yaranmır
    const key = idempotencyKeyFor(ctx.conversationId, toolName, args);
    if (tool.risk !== 'read') {
      const prior = await ctx.repos.assistant.findRunByIdempotency(ctx.companyId, key);
      if (prior && prior.id !== runId) {
        const o: Omit<GatewayOutcome, 'toolRunId'> =
          prior.status === 'approval_required'
            ? {
                status: 'approval_required',
                approvalId: prior.approvalId ?? undefined,
                reused: true,
                summary: 'Same request is already awaiting approval',
                content: json({
                  status: 'approval_required',
                  approvalId: prior.approvalId,
                  message: 'This exact action is already awaiting human approval.',
                }),
              }
            : {
                status: 'succeeded',
                reused: true,
                summary: prior.resultSummary ?? 'Already executed',
                content: json({
                  status: 'already_executed',
                  message: 'This exact action was already executed.',
                  summary: prior.resultSummary,
                }),
              };
        return finish(o, { validatedArgs: args, idempotencyKey: key });
      }
    }

    // 5. risk
    if (tool.risk === 'moderate-write') {
      const preview = tool.preview
        ? tool.preview(args)
        : `${toolName} ${json(maskJsonValue(args)).slice(0, 500)}`;
      const approval = await ctx.repos.approvals.create(
        newApproval({
          companyId: ctx.companyId,
          kind: `tool:${toolName}`,
          resourceRef: `tool_run:${runId}`,
          payload: { tool: toolName, args: maskJsonValue(args), preview },
          requesterId: ctx.userId,
          expiresAt: new Date(ctx.now.getTime() + APPROVAL_TTL_MS),
          now: ctx.now,
        }),
      );
      return finish(
        {
          status: 'approval_required',
          approvalId: approval.id,
          summary: `Approval required: ${preview}`,
          content: json({
            status: 'approval_required',
            approvalId: approval.id,
            preview,
            message:
              'APPROVAL_REQUIRED: a different authorised user must approve this action before it runs. Tell the user.',
          }),
        },
        { validatedArgs: args, idempotencyKey: key, approvalId: approval.id },
      );
    }

    try {
      const result = await tool.handler(ctx, args);
      const content = json(result);
      return await finish(
        { status: 'succeeded', summary: content.slice(0, 300), content },
        { validatedArgs: args, idempotencyKey: tool.risk === 'read' ? undefined : key },
      );
    } catch (e) {
      // A-13: xəta saxta uğur kimi qaytarılmır; modelə daxili detal verilmir
      const known =
        e instanceof Error &&
        'code' in e &&
        typeof (e as { code: unknown }).code === 'string' &&
        e.name === 'AccountingError';
      const message = known ? (e as Error).message : 'The tool failed.';
      return finish(
        {
          status: 'failed',
          summary: `failed: ${message}`.slice(0, 300),
          content: json({ error: 'TOOL_FAILED', message }),
        },
        { validatedArgs: args, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) },
      );
    }
  }
}

/** Təsdiqdən sonra: saxlanılmış arqumentlərlə, SORĞU SAHİBİNİN cari icazələri ilə icra. */
export async function executeApprovedToolRun(
  deps: {
    registry: ToolRegistry;
    repos: Repos;
    buildCtx: (
      base: Pick<
        ToolContext,
        'companyId' | 'userId' | 'permissions' | 'conversationId' | 'requestId'
      >,
    ) => ToolContext;
  },
  approval: { id: string; companyId: string; requesterId: string },
  requestId: string,
): Promise<{ status: 'succeeded' | 'failed' | 'skipped'; message: string }> {
  const run = await deps.repos.assistant.findRunByApproval(approval.id);
  if (!run || run.status !== 'approval_required')
    return { status: 'skipped', message: 'No pending tool run for this approval' };
  const started = Date.now();
  const fail = async (message: string, rejectReason?: string) => {
    await deps.repos.assistant.finishToolRun(run.id, {
      status: 'failed',
      validatedArgs: run.validatedArgs,
      rejectReason: rejectReason ?? null,
      error: message,
      resultSummary: message,
      approvalId: approval.id,
      durationMs: Date.now() - started,
      idempotencyKey: run.idempotencyKey,
    });
    return { status: 'failed' as const, message };
  };
  const tool = deps.registry.get(run.toolName);
  if (!tool || !tool.available) return fail('Tool is no longer available');
  const perms = (await deps.repos.roles.getUserPermissions(run.userId)).map((p) => p.code);
  if (!perms.includes(tool.permission))
    return fail('Requester no longer has permission', 'forbidden');
  const args = tool.args.safeParse(run.validatedArgs);
  if (!args.success) return fail('Stored arguments no longer validate');
  try {
    const ctx = deps.buildCtx({
      companyId: approval.companyId,
      userId: run.userId,
      permissions: perms,
      conversationId: run.conversationId,
      requestId,
    });
    const result = await tool.handler(ctx, args.data);
    const summary = json(result).slice(0, 300);
    await deps.repos.assistant.finishToolRun(run.id, {
      status: 'succeeded',
      validatedArgs: run.validatedArgs,
      resultSummary: summary,
      approvalId: approval.id,
      durationMs: Date.now() - started,
      idempotencyKey: run.idempotencyKey,
    });
    return { status: 'succeeded', message: summary };
  } catch (e) {
    return fail(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
}
