import { dec, formatAmount, sum } from '../accounting/index.js';
import { createRepos } from '../db/index.js';
import { importInvoiceFromText } from '../invoices/ai-import.js';
import { UpstreamError } from '../rag/clients.js';
import { InvoiceParseError, parseInvoiceXml } from '../documents/etaxes.js';
import { validateInvoice } from '../invoices/service.js';
import { PermanentJobError, type JobHandler } from './types.js';

/**
 * `invoice.parse` — e-qaimə XML-i şablonla (AI-sız) parse edir: counterparty + invoice + lines yaradır,
 * invoice::check işlədir, import_jobs-a nəticə yazır. Tanınmayan/pozuq fayl → import_jobs.failed (təkrar cəhd yoxdur).
 */
export const invoiceParseHandler: JobHandler = async (job, deps) => {
  const versionId = (job.payload as { fileVersionId?: unknown } | null)?.fileVersionId;
  if (typeof versionId !== 'string' || !job.companyId)
    throw new PermanentJobError('invoice.parse requires companyId and payload.fileVersionId');
  const companyId = job.companyId;
  const { repos, storage, db } = deps;

  const version = await repos.files.findVersion(companyId, versionId);
  if (!version) throw new PermanentJobError(`File version ${versionId} not found`);
  const file = await repos.files.findById(companyId, version.fileId);
  const company = await repos.companies.findById(companyId);
  if (!file || !company) throw new PermanentJobError('File or company not found');

  const [importJob] = await db.query<{ id: string }>(
    `INSERT INTO import_jobs (company_id, source, file_id, status) VALUES ($1,'etaxes',$2,'running') RETURNING id`,
    [companyId, file.id],
  );
  const finish = (
    status: 'done' | 'failed',
    ok: number,
    failed: number,
    error: string | null,
    template: string | null,
  ) =>
    db.query(
      `UPDATE import_jobs SET status=$2, rows_ok=$3, rows_failed=$4, error=$5, template_version=$6, updated_at=NOW() WHERE id=$1`,
      [importJob!.id, status, ok, failed, error, template],
    );

  const finishEarly = (
    status: 'done' | 'failed',
    ok: number,
    failed: number,
    error: string | null,
    template: string | null,
  ) => finish(status, ok, failed, error, template);

  // PDF / şəkil: əvvəl file.extract (mətn/OCR) bitməlidir, sonra model çıxarışı
  if (version.mime === 'application/pdf' || version.mime.startsWith('image/')) {
    const ex = await repos.files.findExtraction(companyId, versionId);
    if (!ex || ex.status === 'pending' || ex.status === 'extracting') {
      await db.query(`DELETE FROM import_jobs WHERE id = $1`, [importJob!.id]);
      throw new Error('Extraction is not finished yet — will retry'); // keçici: iş geri çəkilmə ilə təkrar olunur
    }
    if (ex.status === 'failed' || !ex.text) {
      await finishEarly(
        'failed',
        0,
        1,
        `Extraction failed: ${ex.error ?? 'no text'}`,
        'ai-extract',
      );
      return { status: 'failed', error: ex.error };
    }
    if (!deps.models) {
      await finishEarly('failed', 0, 1, 'Invoice extraction model is not configured', 'ai-extract');
      return { status: 'failed', error: 'no model' };
    }
    try {
      const out = await importInvoiceFromText(
        {
          db,
          repos,
          models: deps.models,
          ...(deps.reviewThreshold !== undefined ? { reviewThreshold: deps.reviewThreshold } : {}),
          log: deps.log,
        },
        { companyId, companyVoen: company.voen, fileId: file.id, text: ex.text },
      );
      await finishEarly('done', 1, 0, null, 'ai-extract');
      return out;
    } catch (e) {
      if (e instanceof UpstreamError) {
        await db.query(`DELETE FROM import_jobs WHERE id = $1`, [importJob!.id]);
        throw e; // model əlçatmaz: təkrar cəhd
      }
      await finishEarly(
        'failed',
        0,
        1,
        `AI extraction failed: ${(e as Error).message}`,
        'ai-extract',
      );
      return { status: 'failed', error: (e as Error).message };
    }
  }

  const buffer = await storage.get(version.storageKey);
  let parsed;
  try {
    parsed = parseInvoiceXml(buffer.toString('utf8'));
    if (!parsed) throw new InvoiceParseError('XML does not match any known invoice template');
  } catch (e) {
    if (!(e instanceof InvoiceParseError)) throw e;
    await finish('failed', 0, 1, e.message, null);
    return { status: 'failed', error: e.message };
  }

  // Sətirləri pul kimi doğrula (float yox) və başlığı hesabla
  let lineNets;
  try {
    lineNets = parsed.lines.map((l) => ({ net: dec(l.net), vat: dec(l.vat) }));
    dec(parsed.lines[0]!.qty);
    dec(parsed.lines[0]!.unitPrice);
  } catch (e) {
    await finish('failed', 0, 1, `Invalid amount: ${(e as Error).message}`, parsed.templateVersion);
    return { status: 'failed', error: (e as Error).message };
  }
  const net = parsed.net ?? formatAmount(sum(lineNets.map((l) => l.net)));
  const vat = parsed.vat ?? formatAmount(sum(lineNets.map((l) => l.vat)));
  const gross = parsed.gross ?? formatAmount(dec(net).plus(vat));

  // İstiqamət: satıcı bizim VÖEN-dirsə satış, əks halda alış
  const direction =
    parsed.seller.voen && parsed.seller.voen === company.voen ? 'sales' : 'purchase';
  const other = direction === 'sales' ? parsed.buyer : parsed.seller;

  const id = await db.tx(async (tx) => {
    const r = createRepos(tx);
    const counterpartyId = await r.invoices.upsertCounterparty(companyId, other);
    const invoiceId = await r.invoices.create({
      companyId,
      direction,
      number: parsed.number,
      issueDate: parsed.issueDate,
      counterpartyId,
      currency: parsed.currency,
      net,
      vat,
      gross,
      status: 'extracted',
      sourceFileId: file.id,
      extractionConfidence: '1.000', // şablon parse = deterministik, AI yoxdur
      templateVersion: parsed.templateVersion,
      lines: parsed.lines,
    });
    const inv = (await r.invoices.find(companyId, invoiceId))!;
    await validateInvoice(r, inv);
    return invoiceId;
  });
  await finish('done', 1, 0, null, parsed.templateVersion);
  return { status: 'done', invoiceId: id };
};
