import type { Db } from './client.js';
import { AssistantRepository } from './repos/assistant.js';
import { LedgerRepository } from './repos/ledger.js';
import { VatRepository } from './repos/vat.js';
import { ApprovalRepository } from './repos/approvals.js';
import { AuditRepository } from './repos/audit.js';
import { ChunkRepository } from './repos/chunks.js';
import { CompanyRepository } from './repos/companies.js';
import { FileRepository } from './repos/files.js';
import { IngestionRepository } from './repos/ingestion.js';
import { InvoiceRepository } from './repos/invoices.js';
import { JobRepository } from './repos/jobs.js';
import { RoleRepository } from './repos/roles.js';
import { SessionRepository } from './repos/sessions.js';
import { TaxRateRepository } from './repos/tax-rates.js';
import { UserRepository } from './repos/users.js';

export * from './client.js';
export * from './errors.js';
export { migrate, MIGRATIONS_DIR } from './migrate.js';
export { PgliteDb } from './pglite.js';

/** Bütün repository-lər bir Db (və ya transaksiya) üzərində. */
export interface Repos {
  companies: CompanyRepository;
  users: UserRepository;
  roles: RoleRepository;
  sessions: SessionRepository;
  audit: AuditRepository;
  approvals: ApprovalRepository;
  files: FileRepository;
  jobs: JobRepository;
  taxRates: TaxRateRepository;
  invoices: InvoiceRepository;
  ingestion: IngestionRepository;
  chunks: ChunkRepository;
  assistant: AssistantRepository;
  ledger: LedgerRepository;
  vat: VatRepository;
}

export function createRepos(db: Db): Repos {
  return {
    companies: new CompanyRepository(db),
    users: new UserRepository(db),
    roles: new RoleRepository(db),
    sessions: new SessionRepository(db),
    audit: new AuditRepository(db),
    approvals: new ApprovalRepository(db),
    files: new FileRepository(db),
    jobs: new JobRepository(db),
    taxRates: new TaxRateRepository(db),
    invoices: new InvoiceRepository(db),
    ingestion: new IngestionRepository(db),
    chunks: new ChunkRepository(db),
    assistant: new AssistantRepository(db),
    ledger: new LedgerRepository(db),
    vat: new VatRepository(db),
  };
}
