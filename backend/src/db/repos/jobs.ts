import type { Job, JobStatus } from '../../domain/index.js';
import { toJson, type Db } from '../client.js';

interface JobRow {
  id: string;
  company_id: string | null;
  queue: string;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
  result: unknown;
  idempotency_key: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
  [k: string]: unknown;
}

const COLS = `id, company_id, queue, payload, status, attempts, max_attempts, run_at, locked_at,
  locked_by, last_error, result, idempotency_key, created_at, updated_at, finished_at`;

const toJob = (r: JobRow): Job => ({
  id: r.id,
  companyId: r.company_id,
  queue: r.queue,
  payload: r.payload,
  status: r.status,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  runAt: r.run_at,
  lockedAt: r.locked_at,
  lockedBy: r.locked_by,
  lastError: r.last_error,
  result: r.result,
  idempotencyKey: r.idempotency_key,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
});

export interface EnqueueInput {
  queue: string;
  companyId?: string | null;
  payload?: unknown;
  runAt?: Date;
  maxAttempts?: number;
  /** Eyni (queue, key) ikinci dəfə növbələnmir; mövcud iş qaytarılır. */
  idempotencyKey?: string;
}

export class JobRepository {
  constructor(private readonly db: Db) {}

  /** @returns işin özü və yeni yaranıb-yaranmadığı. */
  async enqueue(
    input: EnqueueInput,
    now: Date = new Date(),
  ): Promise<{ job: Job; created: boolean }> {
    const rows = await this.db.query<JobRow>(
      `INSERT INTO jobs (company_id, queue, payload, run_at, max_attempts, idempotency_key, created_at, updated_at)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$7)
       ON CONFLICT (queue, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING ${COLS}`,
      [
        input.companyId ?? null,
        input.queue,
        toJson(input.payload ?? {}),
        input.runAt ?? now,
        input.maxAttempts ?? 5,
        input.idempotencyKey ?? null,
        now,
      ],
    );
    const inserted = rows[0];
    if (inserted) return { job: toJob(inserted), created: true };
    const [existing] = await this.db.query<JobRow>(
      `SELECT ${COLS} FROM jobs WHERE queue = $1 AND idempotency_key = $2`,
      [input.queue, input.idempotencyKey],
    );
    if (!existing) throw new Error('enqueue conflict but job not found');
    return { job: toJob(existing), created: false };
  }

  /** FOR UPDATE SKIP LOCKED: paralel işçilər eyni işi götürə bilməz. */
  async claim(workerId: string, queues: readonly string[], now: Date): Promise<Job | null> {
    const [row] = await this.db.query<JobRow>(
      `UPDATE jobs SET status = 'running', locked_at = $1, locked_by = $2,
              attempts = attempts + 1, updated_at = $1
        WHERE id = (
          SELECT id FROM jobs
           WHERE status = 'queued' AND run_at <= $1 AND queue = ANY($3::text[])
           ORDER BY run_at, created_at
           FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING ${COLS}`,
      [now, workerId, queues],
    );
    return row ? toJob(row) : null;
  }

  async succeed(id: string, result: unknown, now: Date): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'succeeded', result = $2::jsonb, last_error = NULL,
              locked_at = NULL, locked_by = NULL, finished_at = $3, updated_at = $3 WHERE id = $1`,
      [id, toJson(result), now],
    );
  }

  /** Xəta: limit aşılmayıbsa `retryAt`-da yenidən növbəyə, aşılıbsa `dead`. */
  async fail(id: string, error: string, retryAt: Date | null, now: Date): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = $2, last_error = $3, run_at = COALESCE($4, run_at),
              locked_at = NULL, locked_by = NULL, finished_at = $6, updated_at = $5 WHERE id = $1`,
      [id, retryAt ? 'queued' : 'dead', error.slice(0, 4000), retryAt, now, retryAt ? null : now],
    );
  }

  /** İşçi çöküb: `staleBefore`-dan əvvəl kilidlənmiş running işləri yenidən növbəyə qaytarır (və ya limit aşılıbsa dead). */
  async recoverStale(staleBefore: Date, now: Date): Promise<number> {
    const rows = await this.db.query(
      `UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
              last_error = 'worker lost (visibility timeout)', locked_at = NULL, locked_by = NULL,
              updated_at = $2
        WHERE status = 'running' AND locked_at < $1 RETURNING id`,
      [staleBefore, now],
    );
    return rows.length;
  }

  async findById(id: string): Promise<Job | null> {
    const [row] = await this.db.query<JobRow>(`SELECT ${COLS} FROM jobs WHERE id = $1`, [id]);
    return row ? toJob(row) : null;
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.db.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM jobs GROUP BY status`,
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }
}
