export type DomainErrorKind =
  | 'INVALID_STATE_TRANSITION'
  | 'SELF_APPROVAL_FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN';

/** Biznes qaydası pozuntusu. IO yoxdur — API qatı bunu HTTP koduna çevirir. */
export class DomainError extends Error {
  constructor(
    readonly kind: DomainErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
