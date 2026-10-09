import { AccountingError } from './errors.js';

/**
 * (Faza 2) Əmək haqqı: gəlir vergisi, DSMF, işsizlik sığortası, icbari tibbi sığorta.
 * Hələlik yalnız yer tutucu — dərəcələr `tax_rates` (INCOME / SOCIAL) cədvəlindən gələcək,
 * heç vaxt burada sabit yazılmayacaq. Səhv/natamam hesablama qaytarmaq əvəzinə açıq xəta atır.
 */
export const PAYROLL_PHASE = 2 as const;

export function calculate(): never {
  throw new AccountingError('NOT_IMPLEMENTED', 'Payroll calculation is planned for phase 2');
}
