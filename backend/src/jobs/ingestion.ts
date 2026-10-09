import { Cron } from 'croner';
import { cbarUrl, parseCbarXml } from '../ingestion/cbar.js';
import { runSourceFetch } from '../ingestion/pipeline.js';
import { PermanentJobError, QUEUES, type JobHandler } from './types.js';

export const STALE_AFTER_MS = 24 * 3_600_000;

/** `source.fetch` — bir mənbəni çəkir. Xəta fetch_runs-a yazılır; iş özü uğurla bitir (təkrar cədvəldəki cron-la). */
export const sourceFetchHandler: JobHandler = async (job, deps) => {
  const sourceId = (job.payload as { sourceId?: unknown } | null)?.sourceId;
  if (typeof sourceId !== 'string')
    throw new PermanentJobError('source.fetch requires payload.sourceId');
  if (!deps.fetcher) throw new PermanentJobError('No page fetcher configured');
  const source = await deps.repos.ingestion.getSource(sourceId);
  if (!source) throw new PermanentJobError(`Source ${sourceId} not found`);
  if (!source.enabled) return { skipped: 'disabled' };
  const stats = await runSourceFetch(
    { db: deps.db, repos: deps.repos, fetcher: deps.fetcher, log: deps.log },
    source,
  );
  return { status: stats.status, itemsNew: stats.itemsNew, errors: stats.errors.length };
};

/** Dəqiqəlik: hər aktiv mənbə üçün öz `fetch_cron`-una görə vaxtı çatıbsa fetch növbələyir. */
export const sourcesTickHandler: JobHandler = async (_job, deps) => {
  const now = new Date();
  let enqueued = 0;
  for (const s of await deps.repos.ingestion.listSources({ enabledOnly: true })) {
    let due: boolean;
    try {
      const last = await deps.repos.ingestion.lastRunStart(s.id);
      const next = new Cron(s.fetchCron, { timezone: 'UTC', paused: true }).nextRun(
        last ?? new Date(0),
      );
      due = next !== null && next <= now;
    } catch {
      deps.log.error({ sourceId: s.id, cron: s.fetchCron }, 'invalid fetch_cron');
      continue;
    }
    if (!due) continue;
    const { created } = await deps.repos.jobs.enqueue(
      {
        queue: QUEUES.SOURCE_FETCH,
        payload: { sourceId: s.id },
        idempotencyKey: `fetch:${s.id}:${now.toISOString().slice(0, 16)}`,
      },
      now,
    );
    if (created) enqueued++;
  }
  return { enqueued };
};

/** Saatlıq: 24 saatdır uğurlu fetch olmayan mənbə üçün admin xəbərdarlığı; bərpa olunanda bağlanır. */
export const sourcesHealthHandler: JobHandler = async (_job, deps) => {
  const now = new Date();
  let opened = 0;
  for (const s of await deps.repos.ingestion.listSources({ enabledOnly: true })) {
    const ok = await deps.repos.ingestion.lastSuccess(s.id);
    const stale = !ok || now.getTime() - ok.getTime() > STALE_AFTER_MS;
    if (stale) {
      const since = ok ? `last success ${ok.toISOString()}` : 'never fetched successfully';
      if (
        await deps.repos.ingestion.openAlert(
          'source_stale',
          s.id,
          `Source "${s.name}" has not been updated for 24h (${since})`,
        )
      )
        opened++;
    } else {
      await deps.repos.ingestion.resolveAlert('source_stale', s.id, now);
    }
  }
  return { opened };
};

/** Gündəlik CBAR məzənnələri (bugün; payload.date ilə konkret gün). Xəta işi təkrar cəhd edir (geri çəkilmə). */
export const fxCbarHandler: JobHandler = async (job, deps) => {
  if (!deps.fetcher) throw new PermanentJobError('No page fetcher configured');
  const date =
    (job.payload as { date?: string } | null)?.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PermanentJobError('invalid date');
  const res = await deps.fetcher.get(cbarUrl(date));
  if (res.status !== 200) throw new Error(`CBAR returned HTTP ${res.status}`);
  const parsed = parseCbarXml(res.body);
  if (parsed.date !== date)
    throw new Error(`CBAR returned rates for ${parsed.date}, expected ${date}`);
  const n = await deps.repos.vat.upsertFx(parsed.rates.map((r) => ({ ...r, date })));
  return { date, currencies: n };
};
