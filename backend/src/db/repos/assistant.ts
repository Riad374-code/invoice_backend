import { toJson, type Db } from '../client.js';

type R = Record<string, unknown>;

export interface MessageRow {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  citations: unknown;
  toolCalls: unknown;
  toolCallId: string | null;
  modelVersion: string | null;
  createdAt: Date;
}
export interface ConversationRow {
  id: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export type ToolRunStatus = 'running' | 'rejected' | 'approval_required' | 'succeeded' | 'failed';
export interface ToolRunRow {
  id: string;
  companyId: string;
  userId: string;
  conversationId: string | null;
  toolName: string;
  requestedArgs: unknown;
  validatedArgs: unknown;
  status: ToolRunStatus;
  rejectReason: string | null;
  error: string | null;
  resultSummary: string | null;
  approvalId: string | null;
  durationMs: number | null;
  idempotencyKey: string | null;
  createdAt: Date;
}

const MSG = `id, conversation_id, role, content, citations, tool_calls, tool_call_id, model_version, created_at`;
const toMsg = (r: R): MessageRow => ({
  id: r['id'] as string,
  conversationId: r['conversation_id'] as string,
  role: r['role'] as MessageRow['role'],
  content: r['content'] as string,
  citations: r['citations'],
  toolCalls: r['tool_calls'],
  toolCallId: r['tool_call_id'] as string | null,
  modelVersion: r['model_version'] as string | null,
  createdAt: r['created_at'] as Date,
});
const RUN = `id, company_id, user_id, conversation_id, tool_name, requested_args, validated_args, status, reject_reason, error, result_summary, approval_id, duration_ms, idempotency_key, created_at`;
const toRun = (r: R): ToolRunRow => ({
  id: r['id'] as string,
  companyId: r['company_id'] as string,
  userId: r['user_id'] as string,
  conversationId: r['conversation_id'] as string | null,
  toolName: r['tool_name'] as string,
  requestedArgs: r['requested_args'],
  validatedArgs: r['validated_args'],
  status: r['status'] as ToolRunStatus,
  rejectReason: r['reject_reason'] as string | null,
  error: r['error'] as string | null,
  resultSummary: r['result_summary'] as string | null,
  approvalId: r['approval_id'] as string | null,
  durationMs: r['duration_ms'] as number | null,
  idempotencyKey: r['idempotency_key'] as string | null,
  createdAt: r['created_at'] as Date,
});

export class AssistantRepository {
  constructor(private readonly db: Db) {}

  // ------------------------------------------------------ conversations
  async createConversation(
    companyId: string,
    userId: string,
    title: string | null,
  ): Promise<ConversationRow> {
    const [r] = await this.db.query<R>(
      `INSERT INTO conversations (company_id, user_id, title) VALUES ($1,$2,$3) RETURNING id, title, created_at, updated_at`,
      [companyId, userId, title],
    );
    return {
      id: r!['id'] as string,
      title: r!['title'] as string | null,
      createdAt: r!['created_at'] as Date,
      updatedAt: r!['updated_at'] as Date,
    };
  }
  /** Söhbət yalnız sahibinə məxsusdur (eyni şirkətdəki başqa istifadəçi də görmür). */
  async getConversation(
    companyId: string,
    userId: string,
    id: string,
  ): Promise<ConversationRow | null> {
    const [r] = await this.db.query<R>(
      `SELECT id, title, created_at, updated_at FROM conversations WHERE id = $1 AND company_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [id, companyId, userId],
    );
    return r
      ? {
          id: r['id'] as string,
          title: r['title'] as string | null,
          createdAt: r['created_at'] as Date,
          updatedAt: r['updated_at'] as Date,
        }
      : null;
  }
  async listConversations(
    companyId: string,
    userId: string,
    limit: number,
  ): Promise<ConversationRow[]> {
    const rows = await this.db.query<R>(
      `SELECT id, title, created_at, updated_at FROM conversations WHERE company_id = $1 AND user_id = $2 AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT $3`,
      [companyId, userId, limit],
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      title: r['title'] as string | null,
      createdAt: r['created_at'] as Date,
      updatedAt: r['updated_at'] as Date,
    }));
  }
  async touchConversation(id: string, title?: string): Promise<void> {
    await this.db.query(
      `UPDATE conversations SET updated_at = NOW(), title = COALESCE(title, $2) WHERE id = $1`,
      [id, title ?? null],
    );
  }

  // ------------------------------------------------------------ messages
  async addMessage(m: {
    companyId: string;
    conversationId: string;
    role: MessageRow['role'];
    content: string;
    citations?: unknown;
    toolCalls?: unknown;
    toolCallId?: string | null;
    modelVersion?: string | null;
  }): Promise<MessageRow> {
    const [r] = await this.db.query<R>(
      `INSERT INTO messages (company_id, conversation_id, role, content, citations, tool_calls, tool_call_id, model_version)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) RETURNING ${MSG}`,
      [
        m.companyId,
        m.conversationId,
        m.role,
        m.content,
        toJson(m.citations ?? []),
        toJson(m.toolCalls ?? null),
        m.toolCallId ?? null,
        m.modelVersion ?? null,
      ],
    );
    return toMsg(r!);
  }
  async listMessages(
    companyId: string,
    conversationId: string,
    limit = 200,
  ): Promise<MessageRow[]> {
    const rows = await this.db.query<R>(
      `SELECT ${MSG} FROM (SELECT ${MSG}, seq FROM messages WHERE company_id = $1 AND conversation_id = $2 ORDER BY seq DESC LIMIT $3) m ORDER BY m.seq`,
      [companyId, conversationId, limit],
    );
    return rows.map(toMsg);
  }
  /** Mesaj yalnız mənsub olduğu söhbətin sahibinə görünür. */
  async getOwnMessage(companyId: string, userId: string, id: string): Promise<MessageRow | null> {
    const [r] = await this.db.query<R>(
      `SELECT m.id, m.conversation_id, m.role, m.content, m.citations, m.tool_calls, m.tool_call_id, m.model_version, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1 AND m.company_id = $2 AND c.user_id = $3`,
      [id, companyId, userId],
    );
    return r ? toMsg(r) : null;
  }

  // ----------------------------------------------------------- tool runs
  async startToolRun(t: {
    companyId: string;
    userId: string;
    conversationId: string | null;
    toolName: string;
    requestedArgs: unknown;
    requestId: string | null;
  }): Promise<string> {
    const [r] = await this.db.query<{ id: string }>(
      `INSERT INTO tool_runs (company_id, user_id, conversation_id, tool_name, requested_args, status, request_id) VALUES ($1,$2,$3,$4,$5::jsonb,'running',$6) RETURNING id`,
      [
        t.companyId,
        t.userId,
        t.conversationId,
        t.toolName,
        toJson(t.requestedArgs ?? null),
        t.requestId,
      ],
    );
    return r!.id;
  }
  async finishToolRun(
    id: string,
    f: {
      status: Exclude<ToolRunStatus, 'running'>;
      validatedArgs?: unknown;
      rejectReason?: string | null;
      error?: string | null;
      resultSummary?: string | null;
      approvalId?: string | null;
      durationMs: number;
      idempotencyKey?: string | null;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE tool_runs SET status=$2, validated_args=$3::jsonb, reject_reason=$4, error=$5, result_summary=$6, approval_id=$7, duration_ms=$8, idempotency_key=$9, updated_at=NOW() WHERE id=$1`,
      [
        id,
        f.status,
        toJson(f.validatedArgs ?? null),
        f.rejectReason ?? null,
        f.error?.slice(0, 2000) ?? null,
        f.resultSummary?.slice(0, 4000) ?? null,
        f.approvalId ?? null,
        f.durationMs,
        f.idempotencyKey ?? null,
      ],
    );
  }
  async findRunByIdempotency(companyId: string, key: string): Promise<ToolRunRow | null> {
    const [r] = await this.db.query<R>(
      `SELECT ${RUN} FROM tool_runs WHERE company_id = $1 AND idempotency_key = $2 AND status IN ('succeeded','approval_required') ORDER BY created_at DESC LIMIT 1`,
      [companyId, key],
    );
    return r ? toRun(r) : null;
  }
  async findRunByApproval(approvalId: string): Promise<ToolRunRow | null> {
    const [r] = await this.db.query<R>(`SELECT ${RUN} FROM tool_runs WHERE approval_id = $1`, [
      approvalId,
    ]);
    return r ? toRun(r) : null;
  }
  async listRuns(companyId: string, limit = 50): Promise<ToolRunRow[]> {
    const rows = await this.db.query<R>(
      `SELECT ${RUN} FROM tool_runs WHERE company_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [companyId, limit],
    );
    return rows.map(toRun);
  }

  // ------------------------------------------------------------ feedback
  async addFeedback(f: {
    companyId: string;
    userId: string;
    messageId: string;
    kind: 'thumbs' | 'correction';
    before: unknown;
    after: unknown;
  }): Promise<string> {
    const [r] = await this.db.query<{ id: string }>(
      `INSERT INTO feedback_events (company_id, user_id, message_id, kind, before, after) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb) RETURNING id`,
      [f.companyId, f.userId, f.messageId, f.kind, toJson(f.before), toJson(f.after)],
    );
    return r!.id;
  }

  /** Qaimə sətri üzrə insan qərarı: AI təklifi (before) → insanın yekun seçimi (after). Model təlimi mənbəyidir. */
  async addLineFeedback(f: {
    companyId: string;
    userId: string;
    invoiceLineId: string;
    kind: 'correction' | 'approval_decision';
    before: unknown;
    after: unknown;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO feedback_events (company_id, user_id, invoice_line_id, kind, before, after) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [f.companyId, f.userId, f.invoiceLineId, f.kind, toJson(f.before), toJson(f.after)],
    );
  }

  // ------------------------------------------------------------ fx rates
  async listFxRates(
    currencies: readonly string[],
    onOrBefore: string,
    notBefore: string,
  ): Promise<
    Array<{ currency: string; date: string; rate: string; nominal: number; source: string }>
  > {
    const rows = await this.db.query<R>(
      `SELECT currency, date::text AS date, rate::text AS rate, nominal, source FROM fx_rates WHERE currency = ANY($1::text[]) AND date <= $2::date AND date >= $3::date ORDER BY date DESC`,
      [[...currencies], onOrBefore, notBefore],
    );
    return rows.map((r) => ({
      currency: (r['currency'] as string).trim(),
      date: r['date'] as string,
      rate: r['rate'] as string,
      nominal: r['nominal'] as number,
      source: r['source'] as string,
    }));
  }
}
