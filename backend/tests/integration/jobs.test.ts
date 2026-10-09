import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExtractorRegistry } from '../../src/documents/index.js';
import { PgliteDb, createRepos, migrate, type Db, type Repos } from '../../src/db/index.js';
import { retryDelayMs } from '../../src/domain/index.js';
import {
  CronScheduler,
  JobWorker,
  PermanentJobError,
  type JobHandler,
} from '../../src/jobs/index.js';
import { MemoryStorage } from '../../src/storage/index.js';

let db: Db;
let repos: Repos;
const logs: string[] = [];
const log = {
  info: () => undefined,
  warn: (_o: object, m: string) => void logs.push(`warn:${m}`),
  error: (_o: object, m: string) => void logs.push(`error:${m}`),
};

beforeAll(async () => {
  db = await PgliteDb.create();
  await migrate(db);
  repos = createRepos(db);
});
beforeEach(async () => {
  await db.exec('DELETE FROM jobs');
});
afterAll(() => db.close());

function worker(
  handlers: Record<string, JobHandler>,
  clock: { now: Date },
  extra: { staleAfterMs?: number } = {},
) {
  return new JobWorker({
    deps: { db, repos, storage: new MemoryStorage(), extractors: new ExtractorRegistry(), log },
    handlers,
    now: () => clock.now,
    ...extra,
  });
}
const row = async (id: string) => (await repos.jobs.findById(id))!;

describe('JobRepository', () => {
  it('enqueue is idempotent per (queue, key); different queues may reuse a key', async () => {
    const a = await repos.jobs.enqueue({
      queue: 'q.idem',
      idempotencyKey: 'k1',
      payload: { n: 1 },
    });
    const b = await repos.jobs.enqueue({
      queue: 'q.idem',
      idempotencyKey: 'k1',
      payload: { n: 2 },
    });
    const c = await repos.jobs.enqueue({ queue: 'q.other', idempotencyKey: 'k1' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(b.job.payload).toEqual({ n: 1 });
    expect(c.created).toBe(true);
    // açarsız işlər hər dəfə yaranır
    const x = await repos.jobs.enqueue({ queue: 'q.nokey' });
    const y = await repos.jobs.enqueue({ queue: 'q.nokey' });
    expect(x.job.id).not.toBe(y.job.id);
  });

  it('claims in run_at order, never claims future jobs, and each job only once', async () => {
    const t0 = new Date('2030-01-01T00:00:00Z');
    const later = await repos.jobs.enqueue({
      queue: 'q.order',
      runAt: new Date(t0.getTime() + 1000),
      payload: 'later',
    });
    const first = await repos.jobs.enqueue({
      queue: 'q.order',
      runAt: new Date(t0.getTime() - 2000),
      payload: 'first',
    });
    const second = await repos.jobs.enqueue({
      queue: 'q.order',
      runAt: new Date(t0.getTime() - 1000),
      payload: 'second',
    });

    const c1 = await repos.jobs.claim('w1', ['q.order'], t0);
    const c2 = await repos.jobs.claim('w2', ['q.order'], t0);
    const c3 = await repos.jobs.claim('w3', ['q.order'], t0);
    expect([c1?.id, c2?.id]).toEqual([first.job.id, second.job.id]);
    expect(c3).toBeNull();
    expect(c1).toMatchObject({ status: 'running', attempts: 1, lockedBy: 'w1' });

    const c4 = await repos.jobs.claim('w3', ['q.order'], new Date(t0.getTime() + 2000));
    expect(c4?.id).toBe(later.job.id);
  });

  it('only claims the queues the worker has handlers for', async () => {
    await repos.jobs.enqueue({ queue: 'q.unhandled' });
    expect(await repos.jobs.claim('w', ['q.something-else'], new Date())).toBeNull();
  });
});

describe('JobWorker', () => {
  it('runs a handler and stores its result', async () => {
    const clock = { now: new Date('2030-02-01T00:00:00Z') };
    const { job } = await repos.jobs.enqueue({ queue: 'q.ok', payload: { x: 2 } }, clock.now);
    const w = worker(
      { 'q.ok': async (j) => ({ doubled: (j.payload as { x: number }).x * 2 }) },
      clock,
    );
    expect(await w.runOnce()).toBe(true);
    expect(await w.runOnce()).toBe(false);
    expect(await row(job.id)).toMatchObject({
      status: 'succeeded',
      result: { doubled: 4 },
      attempts: 1,
      lockedBy: null,
    });
  });

  it('retries with exponential backoff, then marks the job dead at max_attempts', async () => {
    const clock = { now: new Date('2030-03-01T00:00:00Z') };
    const { job } = await repos.jobs.enqueue({ queue: 'q.flaky', maxAttempts: 3 }, clock.now);
    const w = worker(
      {
        'q.flaky': async () => {
          throw new Error('boom');
        },
      },
      clock,
    );

    await w.runOnce();
    let j = await row(job.id);
    expect(j).toMatchObject({ status: 'queued', attempts: 1, lastError: 'Error: boom' });
    expect(j.runAt.getTime() - clock.now.getTime()).toBe(retryDelayMs(1));
    expect(await w.runOnce()).toBe(false); // geri çəkilmə vaxtı hələ çatmayıb

    clock.now = new Date(j.runAt.getTime() + 1);
    await w.runOnce();
    j = await row(job.id);
    expect(j).toMatchObject({ status: 'queued', attempts: 2 });
    expect(j.runAt.getTime() - clock.now.getTime()).toBe(retryDelayMs(2));
    expect(retryDelayMs(2)).toBeGreaterThan(retryDelayMs(1));

    clock.now = new Date(j.runAt.getTime() + 1);
    await w.runOnce();
    j = await row(job.id);
    expect(j).toMatchObject({ status: 'dead', attempts: 3 });
    expect(j.finishedAt).not.toBeNull();
    expect(await w.runOnce()).toBe(false);
    expect(logs).toContain('error:job failed permanently');
  });

  it('PermanentJobError skips retries entirely', async () => {
    const clock = { now: new Date('2030-04-01T00:00:00Z') };
    const { job } = await repos.jobs.enqueue({ queue: 'q.perm', maxAttempts: 5 }, clock.now);
    await worker(
      {
        'q.perm': async () => {
          throw new PermanentJobError('bad payload');
        },
      },
      clock,
    ).runOnce();
    expect(await row(job.id)).toMatchObject({
      status: 'dead',
      attempts: 1,
      lastError: 'PermanentJobError: bad payload',
    });
  });

  it('drain processes everything runnable and returns the count', async () => {
    const clock = { now: new Date('2030-05-01T00:00:00Z') };
    for (let i = 0; i < 4; i++) await repos.jobs.enqueue({ queue: 'q.drain' }, clock.now);
    let ran = 0;
    expect(await worker({ 'q.drain': async () => void ran++ }, clock).drain()).toBe(4);
    expect(ran).toBe(4);
  });

  it('recovers jobs abandoned by a crashed worker (visibility timeout)', async () => {
    const clock = { now: new Date('2030-06-01T00:00:00Z') };
    const { job } = await repos.jobs.enqueue({ queue: 'q.crash', maxAttempts: 2 }, clock.now);
    await repos.jobs.claim('crashed-worker', ['q.crash'], clock.now); // ... və işçi ölür
    const w = worker({ 'q.crash': async () => 'done' }, clock, { staleAfterMs: 60_000 });

    expect(await w.recoverStale()).toBe(0); // hələ vaxtı çatmayıb
    clock.now = new Date(clock.now.getTime() + 61_000);
    expect(await w.recoverStale()).toBe(1);
    expect(await row(job.id)).toMatchObject({
      status: 'queued',
      lastError: expect.stringContaining('worker lost'),
    });
    await w.runOnce();
    expect((await row(job.id)).status).toBe('succeeded');
  });

  it('a job that keeps killing workers ends dead instead of looping forever', async () => {
    const clock = { now: new Date('2030-07-01T00:00:00Z') };
    const { job } = await repos.jobs.enqueue({ queue: 'q.poison', maxAttempts: 1 }, clock.now);
    await repos.jobs.claim('w', ['q.poison'], clock.now);
    clock.now = new Date(clock.now.getTime() + 3_600_000);
    await worker({ 'q.poison': async () => undefined }, clock).recoverStale();
    expect((await row(job.id)).status).toBe('dead');
  });

  it('start() polls in the background and stop() waits for in-flight work', async () => {
    const clock = { now: new Date() };
    const { job } = await repos.jobs.enqueue({ queue: 'q.bg' }, new Date(Date.now() - 1000));
    const w = new JobWorker({
      deps: { db, repos, storage: new MemoryStorage(), extractors: new ExtractorRegistry(), log },
      handlers: { 'q.bg': async () => 'bg-done' },
      pollIntervalMs: 20,
    });
    w.start();
    for (let i = 0; i < 100 && (await row(job.id)).status !== 'succeeded'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await w.stop();
    expect((await row(job.id)).status).toBe('succeeded');
    void clock;
  });
});

describe('CronScheduler', () => {
  it('enqueues one job per tick-minute even if several instances fire (idempotency)', async () => {
    const s1 = new CronScheduler(repos.jobs, log);
    const s2 = new CronScheduler(repos.jobs, log);
    for (const s of [s1, s2])
      s.add({
        name: 'hourly-check',
        pattern: '0 * * * *',
        queue: 'q.cron',
        payload: { check: true },
      });

    const at = new Date('2030-08-01T10:00:00Z');
    expect(await s1.tick('hourly-check', at)).toBe(true);
    expect(await s2.tick('hourly-check', new Date(at.getTime() + 5_000))).toBe(false);
    expect(await s1.tick('hourly-check', new Date('2030-08-01T11:00:00Z'))).toBe(true);
    const rows = await db.query(`SELECT 1 FROM jobs WHERE queue = 'q.cron'`);
    expect(rows).toHaveLength(2);
  });

  it('rejects duplicate registrations and unknown ticks', async () => {
    const s = new CronScheduler(repos.jobs, log);
    s.add({ name: 'x', pattern: '* * * * *', queue: 'q.x' });
    expect(() => s.add({ name: 'x', pattern: '* * * * *', queue: 'q.x' })).toThrow(
      /already registered/,
    );
    await expect(s.tick('nope')).rejects.toThrow(/Unknown cron/);
    s.stop();
  });

  it('start()/stop() do not leave timers running', () => {
    const s = new CronScheduler(repos.jobs, log);
    s.add({ name: 'y', pattern: '* * * * *', queue: 'q.y' });
    s.start();
    s.stop();
  });
});
