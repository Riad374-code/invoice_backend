import { z } from 'zod';
import {
  D,
  assertLocalDate,
  formatAmount,
  fx,
  journal,
  selectRate,
  vat,
  vatDeposit,
  vatTreatmentOf,
  withholding,
  addDays,
} from '../accounting/index.js';
import { PERMISSIONS } from '../domain/index.js';
import { diffText } from '../ingestion/diff.js';
import { validateInvoice } from '../invoices/service.js';
import { createRepos } from '../db/index.js';
import { postEntry } from '../ledger/service.js';
import { PERIOD_RE, computePeriodSummary } from '../vat/summary.js';
import { summaryJson } from '../routes/vat.js';
import { profileTable } from '../documents/excel-ops.js';
import { previewImport, commitImport } from '../imports/service.js';
import { runExcelJob } from '../jobs/excel.js';
import { exportEntries1c } from '../routes/excel.js';
import { loadTable, refJson, runReconciliation, type SourceSpec } from '../recon/service.js';
import { defineTool, ToolRegistry, type ToolContext } from './tools.js';

const MAX_TEXT = 12_000;
const clip = (s: string) =>
  s.length > MAX_TEXT
    ? `${s.slice(0, MAX_TEXT)}\n…[truncated, ${s.length - MAX_TEXT} more characters]`
    : s;
const Money = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a plain decimal string like "100.00"');
const Day = z.string().refine((d) => {
  try {
    assertLocalDate(d);
    return true;
  } catch {
    return false;
  }
}, 'must be YYYY-MM-DD');
const Uuid = z.uuid();
const ReconSource = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('file'),
      fileId: Uuid,
      keyColumn: z.string().min(1),
      amountColumn: z.string().min(1),
      dateColumn: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('invoices'),
      from: Day,
      to: Day,
      direction: z.enum(['sales', 'purchase']).optional(),
    })
    .strict(),
  z.object({ type: z.literal('bank'), from: Day.optional(), to: Day.optional() }).strict(),
]);
const RateCode = z.string().min(1).max(60);
const today = (ctx: ToolContext) => ctx.now.toISOString().slice(0, 10);

async function searchTool(
  ctx: ToolContext,
  query: string,
  types: Array<'legislation' | 'news' | 'file'>,
  date: string,
  limit: number,
) {
  const res = await ctx.search({ query, resourceTypes: types, date, topK: limit });
  if (res.hits.length === 0)
    return { results: [], note: 'No source found in the knowledge base for this query.' };
  return {
    results: res.hits.map((h) => {
      const src = ctx.sources.add({
        id: h.chunkId,
        text: h.text,
        sourceTitle: h.sourceTitle,
        articleRef: h.articleRef,
        versionNo: h.versionNo,
      });
      return {
        label: src.label,
        title: h.sourceTitle,
        article: h.articleRef,
        version: h.versionNo,
        url: h.url,
        text: clip(h.text),
      };
    }),
  };
}

export function registerBuiltinTools(registry: ToolRegistry): void {
  // ------------------------------------------------------------- read tools
  registry.register(
    defineTool({
      name: 'legislation.search',
      risk: 'read',
      permission: PERMISSIONS.LEGISLATION_READ,
      available: true,
      description:
        'Search legislation (laws, tax code, decrees). Returns passages labelled [S#] to cite. `date` selects the version in force on that day (default today).',
      args: z
        .object({
          query: z.string().min(2).max(500),
          date: Day.optional(),
          limit: z.number().int().min(1).max(8).default(5),
        })
        .strict(),
      handler: (ctx, a) => searchTool(ctx, a.query, ['legislation'], a.date ?? today(ctx), a.limit),
    }),
  );
  registry.register(
    defineTool({
      name: 'legislation.get',
      risk: 'read',
      permission: PERMISSIONS.LEGISLATION_READ,
      available: true,
      description:
        'Get the full text of a legislation document (version in force on `date`, default today).',
      args: z.object({ documentId: Uuid, date: Day.optional() }).strict(),
      handler: async (ctx, a) => {
        const doc = await ctx.repos.ingestion.getDocument(a.documentId);
        if (!doc) return { error: 'NOT_FOUND' };
        const v = await ctx.repos.ingestion.versionOn(doc.id, a.date ?? today(ctx));
        return {
          title: doc.title,
          number: doc.officialNumber,
          version: v
            ? {
                versionNo: v.versionNo,
                validFrom: v.validFrom,
                validTo: v.validTo,
                text: clip(v.fullText),
              }
            : null,
        };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'legislation.diff',
      risk: 'read',
      permission: PERMISSIONS.LEGISLATION_READ,
      available: true,
      description: 'Show what changed between two version numbers of a legislation document.',
      args: z
        .object({ documentId: Uuid, from: z.number().int().min(1), to: z.number().int().min(1) })
        .strict(),
      handler: async (ctx, a) => {
        const [x, y] = await Promise.all([
          ctx.repos.ingestion.getVersion(a.documentId, a.from),
          ctx.repos.ingestion.getVersion(a.documentId, a.to),
        ]);
        if (!x || !y) return { error: 'NOT_FOUND' };
        return {
          from: { versionNo: x.versionNo, validFrom: x.validFrom },
          to: { versionNo: y.versionNo, validFrom: y.validFrom },
          changes: diffText(x.fullText, y.fullText)
            .filter((h) => h.type !== 'unchanged')
            .slice(0, 60)
            .map((h) => ({ type: h.type, text: clip(h.text) })),
        };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'news.search',
      risk: 'read',
      permission: PERMISSIONS.NEWS_READ,
      available: true,
      description: 'Search tax and accounting news. Returns passages labelled [S#] to cite.',
      args: z
        .object({
          query: z.string().min(2).max(500),
          limit: z.number().int().min(1).max(8).default(5),
        })
        .strict(),
      handler: (ctx, a) => searchTool(ctx, a.query, ['news'], today(ctx), a.limit),
    }),
  );
  registry.register(
    defineTool({
      name: 'news.get',
      risk: 'read',
      permission: PERMISSIONS.NEWS_READ,
      available: true,
      description: 'Get one news item by id.',
      args: z.object({ id: Uuid }).strict(),
      handler: async (ctx, a) => {
        const n = await ctx.repos.ingestion.getNews(ctx.userId, a.id);
        return n
          ? {
              title: n.title,
              url: n.originalUrl,
              publishedAt: n.publishedAt?.toISOString() ?? null,
              text: clip(n.rawText),
            }
          : { error: 'NOT_FOUND' };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'files.search',
      risk: 'read',
      permission: PERMISSIONS.FILES_READ,
      available: true,
      description:
        "Search the company's own uploaded documents. Returns passages labelled [S#] to cite.",
      args: z
        .object({
          query: z.string().min(2).max(500),
          limit: z.number().int().min(1).max(8).default(5),
        })
        .strict(),
      handler: (ctx, a) => searchTool(ctx, a.query, ['file'], today(ctx), a.limit),
    }),
  );
  registry.register(
    defineTool({
      name: 'files.read_text',
      risk: 'read',
      permission: PERMISSIONS.FILES_READ,
      available: true,
      description: 'Read the extracted text of one of the company files.',
      args: z.object({ fileId: Uuid }).strict(),
      handler: async (ctx, a) => {
        const file = await ctx.repos.files.findById(ctx.companyId, a.fileId); // company_id sessiyadan
        const version = file && (await ctx.repos.files.latestVersion(ctx.companyId, file.id));
        const ex = version && (await ctx.repos.files.findExtraction(ctx.companyId, version.id));
        if (!file || !ex) return { error: 'NOT_FOUND' };
        return ex.status === 'ready' && ex.text
          ? { name: file.name, text: clip(ex.text) }
          : { name: file.name, status: ex.status, error: ex.error };
      },
    }),
  );
  // ------------------------------------------------ RAG/OCR sidecar alətləri
  const needRag = (ctx: ToolContext) => {
    if (!ctx.ragOcr) throw new Error('RAG/OCR service is not configured (RAG_OCR_BASE_URL)');
    return ctx.ragOcr;
  };
  registry.register(
    defineTool({
      name: 'regulations.search',
      risk: 'read',
      permission: PERMISSIONS.LEGISLATION_READ,
      available: true,
      description:
        'Search the Azerbaijani Tax Code index (hybrid semantic+lexical). Returns passages labelled [S#] to cite. validityVerified=false means the effective dates are not legally certified.',
      args: z
        .object({
          query: z.string().min(2).max(500),
          limit: z.number().int().min(1).max(8).default(5),
        })
        .strict(),
      handler: async (ctx, a) => {
        const rows = await needRag(ctx).searchRegulations(a.query, a.limit);
        if (rows.length === 0)
          return { results: [], note: 'No source found in the Tax Code index for this query.' };
        return {
          results: rows.map((r) => {
            const src = ctx.sources.add({
              id: r.id,
              text: r.text,
              sourceTitle: 'Vergi Məcəlləsi',
              articleRef: `maddə ${r.article} — ${r.title}`,
              versionNo: null,
            });
            return {
              label: src.label,
              article: r.article,
              title: r.title,
              url: r.source_url ?? null,
              effectiveFrom: r.effective_from ?? null,
              validityVerified: r.validity_verified ?? false,
              text: clip(r.text),
            };
          }),
        };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'receipts.search',
      risk: 'read',
      permission: PERMISSIONS.FILES_READ,
      available: true,
      description:
        'Find OCR-ed receipts/invoices of this company. Candidates only (scores are ranking signals, never confidence); all are needs_review.',
      args: z
        .object({
          query: z.string().min(2).max(500),
          date: Day.optional(),
          supplier: z.string().min(1).max(200).optional(),
          limit: z.number().int().min(1).max(10).default(5),
        })
        .strict(),
      handler: async (ctx, a) => {
        const rows = await needRag(ctx).searchDocuments({
          companyId: ctx.companyId, // sessiyadan; model seçə bilmir
          query: a.query,
          topK: a.limit,
          date: a.date,
          supplier: a.supplier,
        });
        return {
          candidates: rows.map((r) => ({
            documentId: r.document_id,
            score: r.score,
            reviewStatus: r.review_status,
            supplier: r.fields.supplier ?? null,
            date: r.fields.date ?? null,
            total: r.fields.total_amount ?? null,
            currency: r.fields.currency ?? null,
            issues: r.validation?.issues ?? [],
          })),
          note:
            rows.length === 0 ? 'No matching receipt found; try a supplier or date.' : undefined,
        };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'receipts.get',
      risk: 'read',
      permission: PERMISSIONS.FILES_READ,
      available: true,
      description:
        'Get one OCR-ed receipt with its validation issues. Values flagged unsafe are masked; never treat as verified or post without human approval.',
      args: z.object({ documentId: Uuid }).strict(),
      handler: async (ctx, a) => {
        const d = await needRag(ctx).getDocument(ctx.companyId, a.documentId);
        if (!d) return { error: 'NOT_FOUND' };
        return {
          documentId: d.document_id,
          reviewStatus: d.review_status,
          fields: { ...d.fields, raw_text: clip(d.fields.raw_text) },
          validation: d.validation ?? null,
        };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'receipts.ingest',
      risk: 'low-write',
      permission: PERMISSIONS.FILES_WRITE,
      available: true,
      description:
        'OCR an already uploaded company file (image/PDF) and index it as a receipt for receipts.search. Creates no accounting entries.',
      args: z.object({ fileId: Uuid }).strict(),
      handler: async (ctx, a) => {
        const rag = needRag(ctx);
        if (!ctx.storage) throw new Error('storage is not configured');
        const file = await ctx.repos.files.findById(ctx.companyId, a.fileId);
        const version = file && (await ctx.repos.files.latestVersion(ctx.companyId, file.id));
        if (!file || !version) return { error: 'NOT_FOUND' };
        if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(version.mime))
          return { error: 'UNSUPPORTED_TYPE', mime: version.mime };
        const bytes = await ctx.storage.get(version.storageKey);
        const d = await rag.ingestDocument(ctx.companyId, bytes, file.name, version.mime);
        return {
          documentId: d.document_id,
          reviewStatus: d.review_status,
          issues: d.validation?.issues ?? [],
        };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'invoice.get',
      risk: 'read',
      permission: PERMISSIONS.INVOICES_READ,
      available: true,
      description: 'Get an invoice with its lines and validation issues.',
      args: z.object({ id: Uuid }).strict(),
      handler: async (ctx, a) => {
        const inv = await ctx.repos.invoices.find(ctx.companyId, a.id);
        if (!inv) return { error: 'NOT_FOUND' };
        const [lines, issues] = await Promise.all([
          ctx.repos.invoices.lines(ctx.companyId, inv.id),
          ctx.repos.invoices.issues(ctx.companyId, inv.id),
        ]);
        return {
          id: inv.id,
          direction: inv.direction,
          number: inv.number,
          issueDate: inv.issueDate,
          currency: inv.currency,
          net: inv.net,
          vat: inv.vat,
          gross: inv.gross,
          status: inv.status,
          lines,
          issues,
        };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'invoice.list',
      risk: 'read',
      permission: PERMISSIONS.INVOICES_READ,
      available: true,
      description: 'List invoices (newest first).',
      args: z
        .object({
          direction: z.enum(['sales', 'purchase']).optional(),
          status: z.enum(['extracted', 'needs_review', 'validated', 'posted']).optional(),
          from: Day.optional(),
          to: Day.optional(),
          limit: z.number().int().min(1).max(25).default(10),
        })
        .strict(),
      handler: async (ctx, a) => ({
        invoices: (await ctx.repos.invoices.list(ctx.companyId, a)).slice(0, a.limit).map((i) => ({
          id: i.id,
          direction: i.direction,
          number: i.number,
          issueDate: i.issueDate,
          gross: i.gross,
          currency: i.currency,
          status: i.status,
        })),
      }),
    }),
  );
  registry.register(
    defineTool({
      name: 'invoice.validate',
      risk: 'read',
      permission: PERMISSIONS.INVOICES_READ,
      available: true,
      description:
        'Run the deterministic invoice checks (totals, VAT rate, date, VÖEN, duplicates) WITHOUT changing anything.',
      args: z.object({ id: Uuid }).strict(),
      handler: async (ctx, a) => {
        const inv = await ctx.repos.invoices.find(ctx.companyId, a.id);
        if (!inv) return { error: 'NOT_FOUND' };
        // Dry-run: tranzaksiya içində yoxla və GERİ QAYTAR — alət "read" riskindədir, heç nə yazmır
        const rolledBack = Symbol('rollback');
        let issues: Awaited<ReturnType<typeof validateInvoice>>['issues'] = [];
        try {
          await ctx.db.tx(async (tx) => {
            const { createRepos } = await import('../db/index.js');
            issues = (await validateInvoice(createRepos(tx), inv)).issues;
            throw rolledBack;
          });
        } catch (e) {
          if (e !== rolledBack) throw e;
        }
        return {
          status: issues.some((i) => i.severity === 'error') ? 'has_errors' : 'ok',
          issues: issues.map((i) => ({ code: i.code, severity: i.severity, message: i.message })),
        };
      },
    }),
  );

  // -------------------------------------------- deterministic engine (read)
  registry.register(
    defineTool({
      name: 'vat.calculate',
      risk: 'read',
      permission: PERMISSIONS.VAT_READ,
      available: true,
      description:
        'Deterministic VAT. mode "net": amount is net → VAT and gross. mode "gross": amount includes VAT → net and VAT. Rate is looked up by code on the operation date.',
      args: z
        .object({
          amount: Money,
          rateCode: RateCode,
          date: Day,
          mode: z.enum(['net', 'gross']).default('net'),
        })
        .strict(),
      handler: async (ctx, a) => {
        const rates = await ctx.repos.taxRates.listActive('VAT');
        const r =
          a.mode === 'net'
            ? vat.calculate(a.amount, a.rateCode, a.date, rates)
            : vat.reverse(a.amount, a.rateCode, a.date, rates);
        return {
          net: formatAmount(r.net),
          vat: formatAmount(r.vat),
          gross: formatAmount(r.gross),
          ratePercent: r.ratePercent.toString(),
          treatment: r.treatment,
          rateId: r.rateId,
          legalSourceId: r.rateSourceId,
          explanation: r.explanation,
        };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'withholding.calculate',
      risk: 'read',
      permission: PERMISSIONS.VAT_READ,
      available: true,
      description:
        'Deterministic withholding tax. basis "gross_payment": tax deducted from the payment; "net_payment": payer bears the tax (gross-up).',
      args: z
        .object({
          amount: Money,
          rateCode: RateCode,
          date: Day,
          basis: z.enum(['gross_payment', 'net_payment']).default('gross_payment'),
        })
        .strict(),
      handler: async (ctx, a) => {
        const rates = await ctx.repos.taxRates.listActive('WITHHOLDING');
        const r = withholding.calculate(a.amount, a.rateCode, a.date, rates, undefined, a.basis);
        return {
          base: formatAmount(r.base),
          withheld: formatAmount(r.withheld),
          payable: formatAmount(r.payable),
          ratePercent: r.ratePercent.toString(),
          legalSourceId: r.rateSourceId,
          explanation: r.explanation,
        };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'fx.convert',
      risk: 'read',
      permission: PERMISSIONS.VAT_READ,
      available: true,
      description:
        'Convert an amount between currencies with the official CBAR rate of the given date (previous rate on weekends/holidays).',
      args: z
        .object({ amount: Money, from: z.string().length(3), to: z.string().length(3), date: Day })
        .strict(),
      handler: async (ctx, a) => {
        const cur = [...new Set([a.from, a.to].filter((c) => c !== 'AZN'))];
        const rows = cur.length
          ? await ctx.repos.assistant.listFxRates(cur, a.date, addDays(a.date, -7))
          : [];
        const table: fx.FxRate[] = rows.map((r) => ({
          currency: r.currency,
          date: r.date,
          rate: new D(r.rate),
          nominal: r.nominal,
          source: r.source,
        }));
        const r = fx.convert(a.amount, a.from, a.to, a.date, table);
        return {
          amount: formatAmount(r.amount),
          currency: r.currency,
          ratesUsed: r.ratesUsed.map((x) => ({
            currency: x.currency,
            date: x.date,
            rate: x.rate.toString(),
            nominal: x.nominal,
            source: x.source,
          })),
          explanation: r.explanation,
        };
      },
    }),
  );
  const Op = z
    .object({
      id: z.string().max(60),
      date: Day,
      amount: Money,
      reference: z.string().max(100).nullable().optional(),
      counterpartyVoen: z.string().max(10).nullable().optional(),
    })
    .strict();
  registry.register(
    defineTool({
      name: 'vat_deposit.reconcile',
      risk: 'read',
      permission: PERMISSIONS.VAT_READ,
      available: true,
      description:
        'Reconcile VAT deposit account statement lines against ledger entries (deterministic matching, never guesses between ambiguous candidates).',
      args: z
        .object({
          statement: z
            .array(
              Op.extend({
                operation: z
                  .enum(['top_up', 'vat_payment', 'refund', 'withdrawal', 'other'])
                  .default('other'),
              }),
            )
            .max(200),
          ledger: z.array(Op).max(200),
        })
        .strict(),
      handler: async (_ctx, a) => {
        const matches = vatDeposit.reconcile(a.statement, a.ledger);
        const s = vatDeposit.summarize(matches);
        return {
          summary: {
            matched: s.matched,
            needsReview: s.needsReview,
            unmatchedStatement: s.unmatchedStatement,
            unmatchedLedger: s.unmatchedLedger,
            statementTotal: formatAmount(s.statementTotal),
            ledgerTotal: formatAmount(s.ledgerTotal),
            balanceDifference: formatAmount(s.balanceDifference),
          },
          matches: matches.map((m) => ({
            kind: m.kind,
            statementLineId: m.statementLineId,
            ledgerEntryId: m.ledgerEntryId,
            difference: formatAmount(m.difference),
            explanation: m.explanation,
          })),
        };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'ledger.suggest_entries',
      risk: 'read',
      permission: PERMISSIONS.JOURNAL_READ,
      available: true,
      description: 'Propose (NOT post) journal entries for a validated invoice.',
      args: z.object({ invoiceId: Uuid }).strict(),
      handler: async (ctx, a) => {
        const inv = await ctx.repos.invoices.find(ctx.companyId, a.invoiceId);
        if (!inv) return { error: 'NOT_FOUND' };
        if (inv.status !== 'validated' && inv.status !== 'posted')
          return { error: 'INVOICE_NOT_VALIDATED', hint: 'Validate the invoice first.' };
        const [lines, rates] = await Promise.all([
          ctx.repos.invoices.lines(ctx.companyId, inv.id),
          ctx.repos.taxRates.listActive('VAT'),
        ]);
        const entry = journal.fromInvoice(
          {
            direction: inv.direction,
            number: inv.number,
            issueDate: inv.issueDate,
            lines: lines.map((l) => ({
              description: l.description,
              net: l.net,
              vat: l.vat,
              treatment: vatTreatmentOf(selectRate(rates, 'VAT', l.vatRateCode, inv.issueDate)),
              accountCode: l.accountFinal ?? l.accountSuggestion,
            })),
          },
          {
            receivable: '211',
            payable: '521',
            revenue: '601',
            expense: '731',
            vatOutput: '533',
            vatInput: '241',
          },
        );
        return {
          status: 'proposed',
          description: entry.description,
          lines: entry.lines.map((l) => ({
            account: l.accountCode,
            debit: formatAmount(l.debit),
            credit: formatAmount(l.credit),
          })),
          explanation: entry.explanation,
        };
      },
    }),
  );

  // -------- Hələ backend-i olmayan alətlər (modelə təqdim edilmir, icra olunmur; sonrakı addımlar `available: true` edəcək)
  const pending = (
    name: string,
    risk: 'read' | 'low-write' | 'moderate-write',
    permission: (typeof PERMISSIONS)[keyof typeof PERMISSIONS],
    description: string,
  ) =>
    registry.register(
      defineTool({
        name,
        risk,
        permission,
        description,
        available: false,
        args: z.object({}).strict(),
        handler: async () => ({ error: 'NOT_AVAILABLE' }),
      }),
    );
  registry.register(
    defineTool({
      name: 'vat.period_summary',
      risk: 'read',
      permission: PERMISSIONS.VAT_READ,
      available: true,
      description:
        'VAT summary for a month (YYYY-MM): output/input VAT, payable, exempt and zero-rated turnover. Lists excluded (unvalidated) invoices and blockers.',
      args: z.object({ period: z.string().regex(PERIOD_RE) }).strict(),
      handler: async (ctx, a) =>
        summaryJson(await computePeriodSummary(ctx.repos, ctx.companyId, a.period)),
    }),
  );
  registry.register(
    defineTool({
      name: 'ledger.submit_entries',
      risk: 'moderate-write',
      permission: PERMISSIONS.JOURNAL_WRITE,
      available: true,
      description:
        'Post a PROPOSED journal entry. Always requires approval by a different authorised user before it runs.',
      args: z.object({ entryId: Uuid }).strict(),
      preview: (a) => `Post journal entry ${a.entryId}`,
      handler: async (ctx, a) => {
        if (!ctx.approvedBy) throw new Error('posting without an approver');
        const approver = ctx.approvedBy;
        const e = await ctx.db.tx((tx) =>
          postEntry(createRepos(tx), ctx.companyId, a.entryId, approver, ctx.now),
        );
        return { entryId: e.id, status: e.status };
      },
    }),
  );
  pending('vat_return.draft', 'low-write', PERMISSIONS.VAT_WRITE, 'Draft a VAT return.');
  registry.register(
    defineTool({
      name: 'mhbs.classify',
      risk: 'read',
      permission: PERMISSIONS.JOURNAL_READ,
      available: true,
      description:
        'Suggest an account code for a transaction under MMUS or MHBS (a SUGGESTION only; a human confirms).',
      args: z
        .object({
          description: z.string().min(2).max(500),
          direction: z.enum(['sales', 'purchase']),
          standard: z.enum(['MMUS', 'MHBS']).default('MMUS'),
        })
        .strict(),
      handler: async (ctx, a) => {
        if (!ctx.models) throw new Error('classification model is not configured');
        const chart = await ctx.repos.invoices.chartCodes(ctx.companyId);
        const s = await ctx.models.classifyAccount({
          description: a.description,
          direction: a.direction,
          standard: a.standard,
          ...(chart ? { candidates: chart } : {}),
        });
        if (chart && !chart.some((c) => c.code === s.accountCode))
          return {
            suggestion: null,
            note: 'The model proposed an account that is not in the company chart.',
          };
        return {
          suggestion: {
            accountCode: s.accountCode,
            confidence: s.confidence,
            alternatives: s.alternatives,
          },
          model: s.model,
          status: 'suggestion_only',
        };
      },
    }),
  );

  // ------------------------------------------------ B12: Excel / import / uzlaşma
  registry.register(
    defineTool({
      name: 'import.preview',
      risk: 'read',
      permission: PERMISSIONS.EXCEL_USE,
      available: true,
      description:
        'Preview an import (1c | etaxes | bank) of an uploaded file. Nothing is written; returns valid/invalid row counts and an importId for import.commit.',
      args: z
        .object({
          source: z.enum(['1c', 'etaxes', 'bank']),
          fileId: Uuid,
          defaultDirection: z.enum(['sales', 'purchase']).optional(),
        })
        .strict(),
      handler: async (ctx, a) => {
        const out = await previewImport(
          { repos: ctx.repos, storage: ctx.storage! },
          { companyId: ctx.companyId, userId: ctx.userId, ...a },
        );
        return {
          importId: out.importId,
          template: out.preview.template,
          rowsOk: out.preview.rowsOk,
          rowsFailed: out.preview.rowsFailed,
          errors: out.preview.rows
            .filter((r) => !r.ok)
            .slice(0, 20)
            .map((r) => ({ row: r.row, errors: r.errors })),
        };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'import.commit',
      risk: 'moderate-write',
      permission: PERMISSIONS.IMPORTS_COMMIT,
      available: true,
      description:
        'Apply a previewed import. ALWAYS needs approval by a different authorised user.',
      args: z.object({ importId: Uuid }).strict(),
      preview: (a) => `Commit import ${a.importId}`,
      handler: async (ctx, a) => {
        if (!ctx.approvedBy) throw new Error('commit without an approver');
        return ctx.db.tx((tx) =>
          commitImport(createRepos(tx), ctx.companyId, a.importId, ctx.userId),
        );
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'onec.export_entries',
      risk: 'low-write',
      permission: PERMISSIONS.JOURNAL_READ,
      available: true,
      description: 'Create a NEW 1C export file with the POSTED journal entries of a date range.',
      args: z.object({ from: Day, to: Day }).strict(),
      handler: async (ctx, a) =>
        exportEntries1c(
          { repos: ctx.repos, db: ctx.db, storage: ctx.storage! },
          ctx.companyId,
          ctx.userId,
          a.from,
          a.to,
        ),
    }),
  );
  registry.register(
    defineTool({
      name: 'excel.profile',
      risk: 'read',
      permission: PERMISSIONS.EXCEL_USE,
      available: true,
      description:
        'Profile an uploaded XLSX/CSV file: column types, distinct counts, exact sums, duplicate and empty rows.',
      args: z.object({ fileId: Uuid }).strict(),
      handler: async (ctx, a) => {
        const t = await loadTable(
          { repos: ctx.repos, storage: ctx.storage! },
          ctx.companyId,
          a.fileId,
        );
        return { ...profileTable(t.headers, t.rows), truncated: t.truncated };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'excel.query',
      risk: 'read',
      permission: PERMISSIONS.EXCEL_USE,
      available: true,
      description:
        'Read rows of an uploaded XLSX/CSV file, optionally filtered by a column value (max 50 rows). Never modifies the file.',
      args: z
        .object({
          fileId: Uuid,
          column: z.string().max(100).optional(),
          equals: z.string().max(200).optional(),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .strict(),
      handler: async (ctx, a) => {
        const t = await loadTable(
          { repos: ctx.repos, storage: ctx.storage! },
          ctx.companyId,
          a.fileId,
        );
        let rows = t.rows;
        if (a.column !== undefined) {
          const i = t.headers.findIndex((h) => h.toLowerCase() === a.column!.toLowerCase());
          if (i === -1) return { error: 'UNKNOWN_COLUMN', columns: t.headers };
          if (a.equals !== undefined)
            rows = rows.filter((r) => (r[i] ?? '').toLowerCase() === a.equals!.toLowerCase());
        }
        return { headers: t.headers, totalMatching: rows.length, rows: rows.slice(0, a.limit) };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'excel.generate_report',
      risk: 'low-write',
      permission: PERMISSIONS.EXCEL_USE,
      available: true,
      description:
        'Generate a NEW Excel report (invoices or journal) for a date range. Originals are never changed.',
      args: z.object({ template: z.enum(['invoices', 'journal']), from: Day, to: Day }).strict(),
      handler: async (ctx, a) => {
        const jobId = await ctx.repos.excel.createJob({
          companyId: ctx.companyId,
          userId: ctx.userId,
          operation: 'report',
          inputFileId: null,
          params: a,
        });
        const out = await runExcelJob(
          { db: ctx.db, repos: ctx.repos, storage: ctx.storage! },
          ctx.companyId,
          jobId,
        );
        return { excelJobId: jobId, outputFileId: out.outputFileId, ...(out.result as object) };
      },
    }),
  );
  registry.register(
    defineTool({
      name: 'reconcile.run',
      risk: 'low-write',
      permission: PERMISSIONS.EXCEL_USE,
      available: true,
      description:
        'Reconcile two sources (uploaded file / invoices / bank). The result is stored as PROPOSED matches that a human must confirm.',
      args: z.object({ left: ReconSource, right: ReconSource }).strict(),
      handler: async (ctx, a) => {
        const deps = { repos: ctx.repos, storage: ctx.storage! };
        const out = await runReconciliation(
          deps,
          ctx.companyId,
          a.left as SourceSpec,
          a.right as SourceSpec,
        );
        const id = await ctx.repos.excel.createRecon({
          companyId: ctx.companyId,
          userId: ctx.userId,
          left: out.left,
          right: out.right,
          summary: out.summary,
          matches: out.matches.map((m) => ({
            type: m.type,
            confidence: m.confidence.toFixed(3),
            left: refJson(m.left),
            right: refJson(m.right),
            difference: m.difference ? formatAmount(m.difference) : null,
            explanation: m.explanation,
          })),
        });
        return { reconciliationId: id, status: 'proposed', summary: out.summary };
      },
    }),
  );
}
