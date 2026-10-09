import { taxRate, type TaxRate } from '../../src/accounting/index.js';

/**
 * TEST FIXTURE dərəcələri — real qanunvericilik dərəcələri DEYİL.
 * 2030-07-01 tarixindəki 18% → 20% dəyişikliyi sərhəd testləri üçün uydurulub.
 */
export const FIXTURE_RATES: TaxRate[] = [
  taxRate({
    id: 'vat-std-old',
    taxType: 'VAT',
    code: 'STANDARD',
    ratePercent: '18',
    validFrom: '2001-01-01',
    validTo: '2030-06-30',
    legalSourceId: 'src-tax-code',
  }),
  taxRate({
    id: 'vat-std-new',
    taxType: 'VAT',
    code: 'STANDARD',
    ratePercent: '20',
    validFrom: '2030-07-01',
    legalSourceId: 'src-amendment',
  }),
  taxRate({
    id: 'vat-zero',
    taxType: 'VAT',
    code: 'ZERO',
    ratePercent: '0',
    validFrom: '2001-01-01',
    treatment: 'zero_rated',
  }),
  taxRate({
    id: 'vat-exempt',
    taxType: 'VAT',
    code: 'EXEMPT',
    ratePercent: '0',
    validFrom: '2001-01-01',
    treatment: 'exempt',
  }),
  taxRate({
    id: 'vat-proposed',
    taxType: 'VAT',
    code: 'PROPOSED_ONLY',
    ratePercent: '25',
    validFrom: '2001-01-01',
    status: 'proposed',
  }),
  taxRate({
    id: 'wht-10',
    taxType: 'WITHHOLDING',
    code: 'WHT_10',
    ratePercent: '10',
    validFrom: '2001-01-01',
    legalSourceId: 'src-wht',
  }),
  taxRate({
    id: 'wht-4-5',
    taxType: 'WITHHOLDING',
    code: 'WHT_4_5',
    ratePercent: '4.5',
    validFrom: '2001-01-01',
  }),
];
