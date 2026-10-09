import { createHash, randomUUID } from 'node:crypto';
import { maskJsonValue, maskText } from '../audit/pii.js';
import { createRepos } from '../db/index.js';
import { newAuditEvent } from '../domain/index.js';
import type { JobHandler } from './types.js';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Anonimləşdirmə: VÖEN/FİN/IBAN/telefon (§11) + e-poçt; sirlər `[REDACTED]`. İstifadəçi/şirkət id-ləri heç vaxt ixraca düşmür. */
export function anonymize(value: unknown): unknown {
  const masked = maskJsonValue(value);
  const scrub = (v: unknown): unknown => {
    if (typeof v === 'string') return maskText(v).replace(EMAIL, '[EMAIL]');
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrub(x)]),
      );
    return v;
  };
  return scrub(masked);
}

/** `feedback.export` (həftəlik): anonim JSONL → obyekt anbarı (`exports/feedback/…`) → model-training götürür. Məlumat ölkə daxilində qalır. */
export const feedbackExportHandler: JobHandler = async (_job, deps) => {
  const to = new Date();
  const rows = await deps.repos.admin.unexportedFeedback(to, 10_000);
  if (rows.length === 0) return { exported: 0 };
  const lines = rows.map((r) =>
    JSON.stringify({
      id: randomUUID(), // orijinal id və əlaqələr yoxdur
      kind: r.kind,
      target: r.target,
      day: r.createdAt.toISOString().slice(0, 10), // dəqiq vaxt yox
      before: anonymize(r.before),
      after: anonymize(r.after),
    }),
  );
  const body = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const key = `exports/feedback/${to.toISOString().slice(0, 10)}-${sha256.slice(0, 12)}.jsonl`;
  await deps.storage.put(key, body, { contentType: 'application/x-ndjson', sha256 });
  await deps.db.tx(async (tx) => {
    const r = createRepos(tx);
    await r.admin.recordExport({
      storageKey: key,
      sha256,
      rows: rows.length,
      from: rows[0]!.createdAt,
      to,
    });
    await r.admin.markExported(
      rows.map((x) => x.id),
      to,
    );
  });
  return { exported: rows.length, key };
};

/** `approvals.expire` (saatlıq): vaxtı keçmiş pending təsdiqlər `expired` olur və bağlı obyektlər təmizlənir. */
export const approvalsExpireHandler: JobHandler = async (job, deps) => {
  const now = new Date();
  const rows = await deps.db.query<{
    id: string;
    company_id: string;
    kind: string;
    payload: Record<string, string> | null;
  }>(
    `UPDATE approvals SET status = 'expired', updated_at = $1 WHERE status = 'pending' AND expires_at < $1 RETURNING id, company_id, kind, payload`,
    [now],
  );
  for (const a of rows) {
    const r = deps.repos;
    if (a.kind === 'journal_post' && a.payload?.['entryId'])
      await r.ledger.setApproval(a.company_id, a.payload['entryId'], null);
    else if (a.kind === 'import_commit' && a.payload?.['importId'])
      await r.excel.setImport(a.payload['importId'], { clearApproval: true });
    else if (a.kind === 'tax_rate_proposal' && a.payload?.['taxRateId'])
      await r.impact.deleteProposedRate(a.payload['taxRateId']);
    else if (a.kind.startsWith('tool:')) {
      const run = await r.assistant.findRunByApproval(a.id);
      if (run && run.status === 'approval_required') {
        await r.assistant.finishToolRun(run.id, {
          status: 'rejected',
          validatedArgs: run.validatedArgs,
          rejectReason: 'approval_expired',
          resultSummary: 'Approval expired',
          approvalId: a.id,
          durationMs: 0,
          idempotencyKey: run.idempotencyKey,
        });
      }
    }
    await r.audit.insert(
      newAuditEvent({
        companyId: a.company_id,
        actorId: null,
        action: 'approval.expire',
        resourceType: 'approval',
        resourceId: a.id,
        before: { status: 'pending' },
        after: { status: 'expired' },
        requestId: `job_${job.id}`,
      }),
    );
  }
  return { expired: rows.length };
};
