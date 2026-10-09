export type AccountingErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_DATE'
  | 'INVALID_RATE'
  | 'RATE_NOT_FOUND'
  | 'RATE_AMBIGUOUS'
  | 'FX_RATE_NOT_FOUND'
  | 'INVALID_CURRENCY'
  | 'NOT_IMPLEMENTED';

/** Mühasibat mühərrikinin proqnozlaşdırıla bilən xətası (kod ilə). IO yoxdur. */
export class AccountingError extends Error {
  constructor(
    readonly code: AccountingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AccountingError';
  }
}
