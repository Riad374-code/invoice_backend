/**
 * Deterministik mühasibat mühərriki (BACKEND.md §6). IO YOXDUR: DB, HTTP, fayl sistemi, saat — hamısı
 * çağıran tərəfdən parametr kimi gəlir. Pul yalnız `Decimal` (string/Decimal giriş, `number` yox).
 */
export * as vat from './vat.js';
export * as withholding from './withholding.js';
export * as vatDeposit from './vat-deposit.js';
export * as journal from './journal.js';
export * as taxId from './tax-id.js';
export * as fx from './fx.js';
export * as invoice from './invoice.js';
export * as payroll from './payroll.js';
export * from './rates.js';
export * from './rounding.js';
export * from './money.js';
export * from './dates.js';
export * from './errors.js';
