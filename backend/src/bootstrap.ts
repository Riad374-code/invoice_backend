import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import { D } from './accounting/index.js';
import { createRepos, type Db } from './db/index.js';
import { hashPassword } from './security/index.js';

export type DevSeed = NonNullable<AppConfig['devSeed']>;

/**
 * Development: ilk şirkət + admin istifadəçisi (idempotent).
 * Parol env-dən gəlir (DEV_ADMIN_PASSWORD) — kodda sabit parol yoxdur.
 */
export async function seedDevAdmin(db: Db, seed: DevSeed): Promise<{ created: boolean }> {
  const repos = createRepos(db);
  if (await repos.users.findByEmail(seed.email)) return { created: false };

  const now = new Date();
  let company = await repos.companies.findByVoen(seed.voen);
  company ??= await repos.companies.create({
    id: randomUUID(),
    name: seed.companyName,
    voen: seed.voen,
    baseCurrency: 'AZN',
    isVatPayer: true,
    taxRegime: 'general',
    reportingStandard: 'MMUS',
    chartOfAccountsId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  const user = await repos.users.create({
    id: randomUUID(),
    companyId: company.id,
    email: seed.email,
    passwordHash: await hashPassword(seed.password),
    status: 'active',
    mfaSecret: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  const admin = await repos.roles.findRoleByName('admin');
  if (!admin) throw new Error('System role "admin" missing — run migrations first');
  await repos.roles.assignRoleToUser(user.id, admin.id);
  return { created: true };
}

/**
 * DEVELOPMENT NÜMUNƏ MƏLUMATI — real qanunvericilik dərəcələri deyil, hüquqi mənbəsi yoxdur.
 * Real dərəcələr admin interfeysi (B14) və qanunvericilik ingestion-u (B7) ilə `legal_source_id`-li daxil edilməlidir.
 * Mühərrik dərəcəni həmişə cədvəldən götürür; cədvəl boşdursa hesablama xəta verir (susmur).
 */
export async function seedDevTaxRates(db: Db): Promise<{ created: number }> {
  const repos = createRepos(db);
  if ((await repos.taxRates.list({ taxType: 'VAT' })).length > 0) return { created: 0 };
  const base = {
    validFrom: '2001-01-01',
    validTo: null,
    legalSourceId: null,
    status: 'active' as const,
  };
  const samples = [
    { code: 'STANDARD', ratePercent: new D('18'), treatment: 'taxable' as const },
    { code: 'ZERO', ratePercent: new D('0'), treatment: 'zero_rated' as const },
    { code: 'EXEMPT', ratePercent: new D('0'), treatment: 'exempt' as const },
  ];
  for (const s of samples) await repos.taxRates.create({ taxType: 'VAT', ...base, ...s });
  return { created: samples.length };
}
