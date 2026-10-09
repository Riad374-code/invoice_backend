import { newApproval } from '../domain/index.js';
import { ModelResponseError } from '../models/client.js';
import { PermanentJobError, type JobDeps, type JobHandler } from './types.js';

const RATE_CHANGE_MIN_CONFIDENCE = 0.8;

/**
 * `news.enrich` — classify/summarize (AI çıxışı raw_text-dən AYRI sütunlarda). Vergi dərəcəsi dəyişikliyi aşkarlanarsa:
 * tax_rates(status = proposed) + platforma şirkətində təsdiq sorğusu. Aktivləşmə YALNIZ təsdiqdən sonra.
 */
export const newsEnrichHandler: JobHandler = async (job, deps) => {
  const id = (job.payload as { newsId?: string } | null)?.newsId;
  if (!id) throw new PermanentJobError('news.enrich needs payload.newsId');
  if (!deps.models) return { skipped: 'no model configured' };
  const news = await deps.repos.impact.newsForEnrichment(id);
  if (!news) throw new PermanentJobError(`News ${id} not found`);
  if (news.aiModel) return { skipped: 'already enriched' };
  let c;
  try {
    c = await deps.models.classifyNews(`${news.title}\n\n${news.rawText}`);
  } catch (e) {
    if (e instanceof ModelResponseError) throw new PermanentJobError(e.message);
    throw e; // UpstreamError → təkrar cəhd
  }
  await deps.repos.impact.setNewsAi(id, {
    summary: c.summary,
    category: c.category,
    riskLevel: c.riskLevel,
    tags: c.tags,
    model: c.model,
  });

  let proposal: string | null = null;
  const rc = c.rateChange;
  if (rc && rc.confidence >= RATE_CHANGE_MIN_CONFIDENCE)
    proposal = await proposeRateChange(deps, rc, id, c.model);
  return { category: c.category, riskLevel: c.riskLevel, rateProposal: proposal };
};

export async function proposeRateChange(
  deps: Pick<JobDeps, 'db' | 'repos'>,
  rc: {
    taxType: 'VAT' | 'PROFIT' | 'INCOME' | 'WITHHOLDING' | 'SIMPLIFIED' | 'SOCIAL';
    code: string;
    ratePercent: string;
    validFrom: string;
  },
  newsId: string,
  model: string,
): Promise<string | null> {
  const { repos } = deps;
  const platform = await repos.impact.platformCompanyId();
  if (!platform) {
    await deps.db.query(
      `INSERT INTO system_alerts (kind, source_id, message) SELECT 'rate_change_unrouted', NULL, $1 WHERE NOT EXISTS (SELECT 1 FROM system_alerts WHERE kind = 'rate_change_unrouted' AND resolved_at IS NULL AND message = $1)`,
      [
        `Possible ${rc.taxType} "${rc.code}" rate change (${rc.ratePercent}% from ${rc.validFrom}) detected in news ${newsId}, but no platform company is configured to review it`,
      ],
    );
    return null;
  }
  if (await repos.impact.rateExists(rc.taxType, rc.code, rc.validFrom)) return null; // artıq təklif olunub/aktivdir
  return deps.db.tx(async (tx) => {
    const { createRepos } = await import('../db/index.js');
    const r = createRepos(tx);
    const { D } = await import('../accounting/index.js');
    const rate = await r.taxRates.create({
      taxType: rc.taxType,
      code: rc.code,
      ratePercent: new D(rc.ratePercent),
      validFrom: rc.validFrom,
      validTo: null,
      legalSourceId: null,
      status: 'proposed',
      treatment: null,
    });
    const requester = await r.impact.ensureSystemUser(platform);
    const approval = await r.approvals.create(
      newApproval({
        companyId: platform,
        kind: 'tax_rate_proposal',
        resourceRef: `tax_rate:${rate.id}`,
        requesterId: requester,
        payload: {
          taxRateId: rate.id,
          taxType: rc.taxType,
          code: rc.code,
          ratePercent: rc.ratePercent,
          validFrom: rc.validFrom,
          sourceNewsId: newsId,
          detectedBy: model,
          note: 'AI-detected; verify against the official act before approving',
        },
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      }),
    );
    return approval.id;
  });
}

const FINDINGS_PER_RESOURCE_EVIDENCE = 3;

/**
 * `impact.analyze` — yeni xəbər/qanun versiyası ↔ şirkət fayllarının parçaları (vektor oxşarlığı + rerank).
 * Hər şirkət YALNIZ öz parçaları ilə müqayisə olunur (SQL-də company_id filtri). Nəticə: impact_findings + bildiriş.
 */
export const impactAnalyzeHandler: JobHandler = async (job, deps) => {
  const p = job.payload as {
    sourceKind?: 'news' | 'legislation_version';
    sourceId?: string;
  } | null;
  if (!p?.sourceKind || !p.sourceId)
    throw new PermanentJobError('impact.analyze needs sourceKind and sourceId');
  if (!deps.embedder) return { skipped: 'no embedder configured' };
  const { repos } = deps;
  const src = await repos.impact.sourceChunks(p.sourceKind, p.sourceId);
  if (src.length === 0) throw new Error('Source has no chunks yet — will retry'); // indekslənmə hələ bitməyib
  if (src.some((c) => !c.embedding))
    throw new Error('Source chunks are not embedded yet — will retry');

  const threshold = deps.impactMinSimilarity ?? 0.6;
  const model = deps.embedder.model;
  let created = 0;
  let notified = 0;
  for (const companyId of await repos.impact.companiesWithFileChunks()) {
    const byResource = new Map<
      string,
      {
        best: number;
        evidence: Array<{
          sourceChunkId: string;
          chunkId: string;
          similarity: number;
          excerpt: string;
        }>;
      }
    >();
    for (const sc of src) {
      for (const hit of await repos.impact.nearestCompanyChunks(
        companyId,
        sc.embedding!,
        model,
        threshold,
        5,
      )) {
        const e = byResource.get(hit.resourceId) ?? { best: 0, evidence: [] };
        e.best = Math.max(e.best, hit.similarity);
        e.evidence.push({
          sourceChunkId: sc.id,
          chunkId: hit.chunkId,
          similarity: Number(hit.similarity.toFixed(3)),
          excerpt: hit.text.slice(0, 240),
        });
        byResource.set(hit.resourceId, e);
      }
    }
    for (const [resourceId, e] of byResource) {
      const evidence = e.evidence
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, FINDINGS_PER_RESOURCE_EVIDENCE);
      const f = await repos.impact.upsertFinding({
        companyId,
        sourceKind: p.sourceKind,
        sourceId: p.sourceId,
        resourceId,
        score: Math.min(1, e.best).toFixed(3),
        explanation: `${p.sourceKind === 'news' ? 'A new news item' : 'A new legislation version'} is semantically close (similarity ${e.best.toFixed(2)}) to ${evidence.length} passage(s) of your document.`,
        evidence,
      });
      if (!f.created) continue;
      created++;
      for (const userId of await repos.impact.usersWithPermission(companyId, 'impact:read')) {
        if (
          await repos.impact.notify({
            companyId,
            userId,
            kind: 'impact_finding',
            title: 'New regulatory change may affect your documents',
            body: `Relevance ${e.best.toFixed(2)}`,
            refType: 'impact_finding',
            refId: f.id,
          })
        )
          notified++;
      }
    }
  }
  return { findings: created, notifications: notified };
};
