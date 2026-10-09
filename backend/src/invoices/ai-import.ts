import { D, dec, formatAmount, sum, type TaxRate } from '../accounting/index.js';
import { createRepos, type Db, type Repos } from '../db/index.js';
import { validateInvoice, DEFAULT_REVIEW_THRESHOLD } from './service.js';
import type { ModelServing, ExtractedInvoice } from '../models/client.js';

export interface AiImportDeps {
  db: Db;
  repos: Repos;
  models: ModelServing;
  reviewThreshold?: number;
  log?: { warn(o: object, m: string): void };
}

/** Model faiz verirsə (məs. "18") onu tarixdə qüvvədə olan ƏDV kodu ilə əlaqələndirir; birmənalı deyilsə "UNRESOLVED" (yoxlama bayraqlayır). */
export function resolveRateCode(
  line: { vatPercent?: string | null | undefined; vatRateCode?: string | null | undefined },
  rates: readonly TaxRate[],
  date: string,
): string {
  const active = rates.filter(
    (r) =>
      r.taxType === 'VAT' &&
      r.status === 'active' &&
      r.validFrom <= date &&
      (r.validTo === null || r.validTo >= date),
  );
  if (line.vatRateCode && active.some((r) => r.code === line.vatRateCode)) return line.vatRateCode;
  if (line.vatPercent) {
    const pct = new D(line.vatPercent);
    const matches = active.filter(
      (r) =>
        r.ratePercent.eq(pct) &&
        (pct.gt(0) ? (r.treatment ?? 'taxable') === 'taxable' : r.treatment === 'zero_rated'),
    );
    if (matches.length === 1) return matches[0]!.code;
  }
  return 'UNRESOLVED';
}

/**
 * AI çıxarışı: mətn → `/v1/extract/invoice` → server tərəfdə yenidən yoxlama → invoice/lines (status = extracted → check).
 *  - Model cavabı JSON Schema-ya uyğun deyilsə ModelResponseError (import_jobs.failed).
 *  - Sahə etibarlılığı saxlanılır; < hədd olan sahə varsa qaimə `needs_review` olur (insan yoxlaması).
 *  - Hesab kodu YALNIZ təklifdir (account_suggestion); account_final boş qalır.
 */
export async function importInvoiceFromText(
  deps: AiImportDeps,
  input: { companyId: string; companyVoen: string; fileId: string; text: string },
): Promise<{ invoiceId: string; status: string; model: string }> {
  const threshold = deps.reviewThreshold ?? DEFAULT_REVIEW_THRESHOLD;
  const ex: ExtractedInvoice = await deps.models.extractInvoice(input.text);
  const inv = ex.invoice;
  const rates = await deps.repos.taxRates.listActive('VAT');

  const lines = inv.lines.map((l) => ({
    description: l.description,
    qty: l.qty,
    unitPrice: l.unitPrice,
    net: l.net,
    vat: l.vat,
    vatRateCode: resolveRateCode(l, rates, inv.issueDate),
  }));
  const net = inv.net ?? formatAmount(sum(lines.map((l) => dec(l.net))));
  const vat = inv.vat ?? formatAmount(sum(lines.map((l) => dec(l.vat))));
  const gross = inv.gross ?? formatAmount(dec(net).plus(vat));

  const fieldConfidence: Record<string, number> = { ...ex.confidence };
  // Birmənalı olmayan ƏDV kodu = etibarsız sahə
  lines.forEach((l, i) => {
    if (l.vatRateCode === 'UNRESOLVED') fieldConfidence[`lines.${i}.vatRateCode`] = 0;
  });
  // İstiqamət VÖEN-dən çıxarılır; heç biri bizimki deyilsə təxmin edilir və bu açıq bayraqlanır
  const sellerIsUs = inv.seller.voen === input.companyVoen;
  const buyerIsUs = inv.buyer.voen === input.companyVoen;
  const direction = sellerIsUs ? 'sales' : 'purchase';
  if (!sellerIsUs && !buyerIsUs)
    fieldConfidence['direction'] = Math.min(fieldConfidence['direction'] ?? 1, 0.5);
  const other = direction === 'sales' ? inv.buyer : inv.seller;

  const invoiceId = await deps.db.tx(async (tx) => {
    const r = createRepos(tx);
    const counterpartyId = await r.invoices.upsertCounterparty(input.companyId, {
      name: other.name,
      voen: other.voen ?? null,
      isVatPayer: null,
    });
    const id = await r.invoices.create({
      companyId: input.companyId,
      direction,
      number: inv.number,
      issueDate: inv.issueDate,
      counterpartyId,
      currency: inv.currency,
      net,
      vat,
      gross,
      status: 'extracted',
      sourceFileId: input.fileId,
      extractionConfidence: ex.overallConfidence.toFixed(3),
      templateVersion: null,
      fieldConfidence,
      aiModelVersion: ex.model,
      lines,
    });
    return id;
  });

  // Hesab kodu təklifləri (təklif, final deyil). Model xətası qaiməni pozmur.
  const chart = await deps.repos.invoices.chartCodes(input.companyId);
  const known = chart ? new Set(chart.map((c) => c.code)) : null;
  const stored = await deps.repos.invoices.lines(input.companyId, invoiceId);
  for (const line of stored) {
    try {
      const s = await deps.models.classifyAccount({
        description: line.description,
        direction,
        standard: 'MMUS',
        ...(chart ? { candidates: chart } : {}),
      });
      if (known && !known.has(s.accountCode)) {
        deps.log?.warn(
          { code: s.accountCode },
          'model suggested an account that is not in the company chart — discarded',
        );
        continue;
      }
      await deps.repos.invoices.setLineSuggestion(
        input.companyId,
        line.id,
        s.accountCode,
        s.confidence,
        s.model,
      );
    } catch (e) {
      deps.log?.warn({ err: String(e), lineId: line.id }, 'account suggestion failed');
    }
  }

  const row = (await deps.repos.invoices.find(input.companyId, invoiceId))!;
  const out = await deps.db.tx(async (tx) =>
    validateInvoice(createRepos(tx), row, { reviewThreshold: threshold }),
  );
  return { invoiceId, status: out.status, model: ex.model };
}
