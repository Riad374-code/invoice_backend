import { randomUUID } from 'node:crypto';
import { D } from './accounting/index.js';
import { createRepos, type Db } from './db/index.js';
import { persistProposalForInvoice } from './ledger/service.js';
import { hashPassword } from './security/index.js';
import type { NewInvoice } from './db/repos/invoices.js';

/** Demo şirkətin VÖEN-i sabitdir: seed idempotentdir və real şirkətlərlə toqquşmur (real VÖEN 0 ilə başlamır). */
export const DEMO_VOEN = '0000000001';
export const DEMO_EMAIL_DOMAIN = 'demo.lexaudit.local';

export interface DemoSeedOptions {
  password: string;
  now?: Date;
}

interface DemoInvoice {
  direction: 'sales' | 'purchase';
  number: string;
  date: string;
  party: string;
  status: NewInvoice['status'];
  lines: Array<{ description: string; qty: string; unitPrice: string; vatRateCode?: string }>;
}

const PARTIES = [
  { name: 'Demo Təchizat MMC', voen: '0000000002', isVatPayer: true },
  { name: 'Demo Logistika ASC', voen: '0000000003', isVatPayer: true },
  { name: 'Demo Müştəri MMC', voen: '0000000004', isVatPayer: true },
  { name: 'Demo Kiçik Sahibkar', voen: '0000000005', isVatPayer: false },
];

const INVOICES: DemoInvoice[] = [
  {
    direction: 'sales',
    number: 'DEMO-S-001',
    date: '2026-01-12',
    party: 'Demo Müştəri MMC',
    status: 'posted',
    lines: [{ description: 'Konsaltinq xidməti (yanvar)', qty: '1', unitPrice: '2500.00' }],
  },
  {
    direction: 'sales',
    number: 'DEMO-S-002',
    date: '2026-02-09',
    party: 'Demo Müştəri MMC',
    status: 'validated',
    lines: [
      { description: 'Proqram təminatı lisenziyası', qty: '3', unitPrice: '400.00' },
      { description: 'Quraşdırma xidməti', qty: '1', unitPrice: '350.00' },
    ],
  },
  {
    direction: 'sales',
    number: 'DEMO-S-003',
    date: '2026-03-03',
    party: 'Demo Logistika ASC',
    status: 'needs_review',
    lines: [{ description: 'İxrac xidməti', qty: '1', unitPrice: '1800.00', vatRateCode: 'ZERO' }],
  },
  {
    direction: 'purchase',
    number: 'DEMO-P-001',
    date: '2026-01-20',
    party: 'Demo Təchizat MMC',
    status: 'posted',
    lines: [{ description: 'Ofis ləvazimatı', qty: '10', unitPrice: '25.50' }],
  },
  {
    direction: 'purchase',
    number: 'DEMO-P-002',
    date: '2026-02-14',
    party: 'Demo Logistika ASC',
    status: 'validated',
    lines: [{ description: 'Daşıma xidməti', qty: '4', unitPrice: '120.00' }],
  },
  {
    direction: 'purchase',
    number: 'DEMO-P-003',
    date: '2026-03-18',
    party: 'Demo Kiçik Sahibkar',
    status: 'needs_review',
    lines: [{ description: 'Təmir işləri', qty: '1', unitPrice: '900.00', vatRateCode: 'EXEMPT' }],
  },
];

const CHART = [
  { code: '211', nameAz: 'Alıcılar və sifarişçilərlə hesablaşmalar', type: 'asset' },
  { code: '241', nameAz: 'Əvəzləşdirilən ƏDV', type: 'asset' },
  { code: '521', nameAz: 'Podratçılar və təchizatçılarla hesablaşmalar', type: 'liability' },
  { code: '533', nameAz: 'ƏDV üzrə öhdəliklər', type: 'liability' },
  { code: '601', nameAz: 'Satış gəliri', type: 'revenue' },
  { code: '731', nameAz: 'İnzibati xərclər', type: 'expense' },
];

const VAT_RATES = [
  { code: 'STANDARD', ratePercent: new D('18'), treatment: 'taxable' as const },
  { code: 'ZERO', ratePercent: new D('0'), treatment: 'zero_rated' as const },
  { code: 'EXEMPT', ratePercent: new D('0'), treatment: 'exempt' as const },
];

/**
 * Demo/nümunə məlumat (deploy üçün). Ayrı "DEMO" şirkətində işləyir, buna görə real şirkətlərin
 * qeydiyyatını və məlumat daxil etməsini heç bir şəkildə məhdudlaşdırmır. İdempotentdir.
 * Bütün adlar/VÖEN-lər uydurmadır. Silmək üçün: demo şirkəti (VÖEN 0000000001) silinir.
 */
export async function seedDemoData(
  db: Db,
  opts: DemoSeedOptions,
): Promise<{ created: boolean; ratesCreated: number }> {
  const repos = createRepos(db);
  const now = opts.now ?? new Date();

  // Qlobal dərəcələr yalnız cədvəl boşdursa (real dərəcələr artıq varsa toxunulmur).
  let ratesCreated = 0;
  if ((await repos.taxRates.list({ taxType: 'VAT' })).length === 0) {
    for (const r of VAT_RATES)
      await repos.taxRates.create({
        taxType: 'VAT',
        validFrom: '2001-01-01',
        validTo: null,
        legalSourceId: null,
        status: 'active',
        ...r,
      });
    ratesCreated = VAT_RATES.length;
  }

  if (await repos.companies.findByVoen(DEMO_VOEN)) return { created: false, ratesCreated };

  const passwordHash = await hashPassword(opts.password);
  const companyId = randomUUID();
  await repos.companies.create({
    id: companyId,
    name: 'Demo MMC (nümunə məlumat)',
    voen: DEMO_VOEN,
    baseCurrency: 'AZN',
    isVatPayer: true,
    taxRegime: 'general',
    reportingStandard: 'MMUS',
    chartOfAccountsId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });

  const users: Record<string, string> = {};
  for (const role of ['admin', 'accountant', 'approver', 'viewer']) {
    const u = await repos.users.create({
      id: randomUUID(),
      companyId,
      email: `${role}@${DEMO_EMAIL_DOMAIN}`,
      passwordHash,
      status: 'active',
      mfaSecret: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    const r = await repos.roles.findRoleByName(role);
    if (!r) throw new Error(`System role "${role}" missing — run migrations first`);
    await repos.roles.assignRoleToUser(u.id, r.id);
    users[role] = u.id;
  }

  await repos.ledger.importChart(companyId, 'Demo hesab planı', 'MMUS', CHART);

  const partyIds = new Map<string, string>();
  for (const p of PARTIES)
    partyIds.set(p.name, await repos.invoices.upsertCounterparty(companyId, p));

  for (const inv of INVOICES) {
    const lines = inv.lines.map((l, i) => {
      const net = new D(l.qty).mul(l.unitPrice).toDecimalPlaces(2);
      const rate = (l.vatRateCode ?? 'STANDARD') === 'STANDARD' ? new D('0.18') : new D(0);
      return { l, i, net, vat: net.mul(rate).toDecimalPlaces(2) };
    });
    const net = lines.reduce((s, x) => s.plus(x.net), new D(0));
    const vat = lines.reduce((s, x) => s.plus(x.vat), new D(0));
    const id = await repos.invoices.create({
      companyId,
      direction: inv.direction,
      number: inv.number,
      issueDate: inv.date,
      counterpartyId: partyIds.get(inv.party) ?? null,
      currency: 'AZN',
      net: net.toFixed(2),
      vat: vat.toFixed(2),
      gross: net.plus(vat).toFixed(2),
      status: inv.status,
      sourceFileId: null,
      extractionConfidence: null,
      templateVersion: null,
      lines: lines.map(({ l, i, net: n, vat: v }) => ({
        lineNo: i + 1,
        description: l.description,
        qty: l.qty,
        unitPrice: l.unitPrice,
        vatRateCode: l.vatRateCode ?? 'STANDARD',
        net: n.toFixed(2),
        vat: v.toFixed(2),
      })),
    });
    // Təsdiqlənmiş/yoxlanmış qaimələr üçün TƏKLİF olunan jurnal yazılışı (post demo-da insan təsdiqi ilə edilir).
    if (inv.status === 'validated')
      await persistProposalForInvoice(
        repos,
        { id, companyId, direction: inv.direction, number: inv.number, issueDate: inv.date },
        users['accountant']!,
      );
  }
  return { created: true, ratesCreated };
}
