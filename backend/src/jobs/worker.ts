import { randomUUID } from 'node:crypto';
import { retryDelayMs, type Job } from '../domain/index.js';
import { PermanentJobError, type JobDeps, type JobHandler } from './types.js';

export interface JobWorkerOptions {
  deps: JobDeps;
  handlers: Record<string, JobHandler>;
  workerId?: string;
  pollIntervalMs?: number;
  /** Bu müddətdən uzun "running" qalan iş itmiş işçiyə aid sayılır və yenidən növbəyə qoyulur. */
  staleAfterMs?: number;
  now?: () => Date;
}

/**
 * Postgres əsaslı iş işçisi (`FOR UPDATE SKIP LOCKED`). Bir neçə instans eyni anda işləyə bilər.
 * Xəta → eksponensial geri çəkilmə ilə təkrar; limit aşılanda `dead`.
 */
export class JobWorker {
  private readonly deps: JobDeps;
  private readonly handlers: Record<string, JobHandler>;
  private readonly queues: string[];
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight: Promise<unknown> = Promise.resolve();
  private lastRecovery = 0;

  constructor(opts: JobWorkerOptions) {
    this.deps = opts.deps;
    this.handlers = opts.handlers;
    this.queues = Object.keys(opts.handlers);
    this.workerId = opts.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.staleAfterMs = opts.staleAfterMs ?? 10 * 60_000;
    this.now = opts.now ?? (() => new Date());
  }

  /** Bir iş götürüb icra edir. İş tapılmadısa `false`. */
  async runOnce(): Promise<boolean> {
    const { jobs } = this.deps.repos;
    const job = await jobs.claim(this.workerId, this.queues, this.now());
    if (!job) return false;
    await this.process(job);
    return true;
  }

  /** Növbə boşalana qədər (və ya `max`-a qədər) işləyir. Testlər və deterministik işlər üçün. */
  async drain(max = 1000): Promise<number> {
    let n = 0;
    while (n < max && (await this.runOnce())) n++;
    return n;
  }

  async recoverStale(): Promise<number> {
    const now = this.now();
    const n = await this.deps.repos.jobs.recoverStale(
      new Date(now.getTime() - this.staleAfterMs),
      now,
    );
    if (n > 0) this.deps.log.warn({ recovered: n }, 'recovered stale jobs');
    return n;
  }

  private async process(job: Job): Promise<void> {
    const handler = this.handlers[job.queue];
    const { jobs } = this.deps.repos;
    try {
      if (!handler) throw new PermanentJobError(`No handler for queue "${job.queue}"`);
      const result = await handler(job, this.deps);
      await jobs.succeed(job.id, result ?? null, this.now());
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const now = this.now();
      const permanent = err instanceof PermanentJobError || job.attempts >= job.maxAttempts;
      const retryAt = permanent ? null : new Date(now.getTime() + retryDelayMs(job.attempts));
      this.deps.log[permanent ? 'error' : 'warn'](
        { jobId: job.id, queue: job.queue, attempt: job.attempts, err: message },
        permanent ? 'job failed permanently' : 'job failed, will retry',
      );
      await jobs.fail(job.id, message, retryAt, now);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      let worked = false;
      try {
        if (Date.now() - this.lastRecovery > 60_000) {
          this.lastRecovery = Date.now();
          await this.recoverStale();
        }
        worked = await (this.inFlight = this.runOnce());
      } catch (err) {
        // DB vaxtaşırı əlçatmaz ola bilər — işçi ölməməlidir, növbəti tick yenidən cəhd edir
        this.deps.log.error({ err: String(err) }, 'worker tick failed');
      }
      if (this.running)
        this.timer = setTimeout(() => void tick(), worked ? 0 : this.pollIntervalMs);
    };
    this.timer = setTimeout(() => void tick(), 0);
  }

  /** Yeni iş götürməyi dayandırır və icra olunmaqda olanı gözləyir. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight.catch(() => undefined);
  }
}
