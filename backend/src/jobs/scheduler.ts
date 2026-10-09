import { Cron } from 'croner';
import type { JobRepository } from '../db/repos/jobs.js';
import type { JobLogger } from './types.js';

export interface CronSpec {
  name: string;
  /** Standart 5 sahəli cron ifadəsi (UTC). */
  pattern: string;
  queue: string;
  payload?: unknown;
}

/**
 * Cron → növbəyə iş əlavə edir. İşin açarı (ad + dəqiqə) olduğu üçün bir neçə API instansı eyni vaxtda
 * tetikləsə belə yalnız BİR iş yaranır (uq_jobs_idempotency).
 */
export class CronScheduler {
  private readonly crons = new Map<string, Cron>();
  private readonly specs = new Map<string, CronSpec>();

  constructor(
    private readonly jobs: JobRepository,
    private readonly log: JobLogger,
  ) {}

  add(spec: CronSpec): void {
    if (this.specs.has(spec.name)) throw new Error(`Cron "${spec.name}" already registered`);
    this.specs.set(spec.name, spec);
    this.crons.set(
      spec.name,
      new Cron(spec.pattern, { timezone: 'UTC', protect: true, paused: true }, () => {
        void this.tick(spec.name);
      }),
    );
  }

  /** Bir tetik: iş əlavə edir (testlər üçün birbaşa çağırıla bilər). */
  async tick(name: string, at: Date = new Date()): Promise<boolean> {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`Unknown cron "${name}"`);
    try {
      const { created } = await this.jobs.enqueue(
        {
          queue: spec.queue,
          payload: spec.payload ?? {},
          idempotencyKey: `cron:${name}:${at.toISOString().slice(0, 16)}`,
        },
        at,
      );
      return created;
    } catch (err) {
      this.log.error({ cron: name, err: String(err) }, 'cron enqueue failed');
      return false;
    }
  }

  start(): void {
    for (const c of this.crons.values()) c.resume();
  }

  stop(): void {
    for (const c of this.crons.values()) c.stop();
  }
}
