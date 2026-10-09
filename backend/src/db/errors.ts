/** DB səviyyəsi xətaları. A-13: DB/lock xətası → 5xx, heç vaxt saxta uğur. */
export class DbError extends Error {
  constructor(
    readonly kind: 'NOT_FOUND' | 'CONFLICT' | 'CONSTRAINT' | 'IMMUTABILITY' | 'INTERNAL',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DbError';
  }
}

interface PgLikeError {
  code?: string;
  message?: string;
  constraint?: string;
  detail?: string;
}

export function mapDbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const e = (err ?? {}) as PgLikeError;
  const message = e.message ?? 'Unknown database error';
  switch (e.code) {
    case '23505': // unique_violation
    case '23P01': // exclusion_violation (məs. üst-üstə düşən aktiv vergi dərəcələri)
      return new DbError('CONFLICT', `Unique constraint violated: ${e.constraint ?? message}`, {
        cause: err,
      });
    case '23514': // check_violation
    case '23503': // foreign_key_violation
    case '23502': // not_null_violation
      return new DbError('CONSTRAINT', `Constraint violated: ${e.constraint ?? message}`, {
        cause: err,
      });
    case 'P0001': // raise_exception (audit_events immutability trigger)
      if (message.includes('append-only')) {
        return new DbError('IMMUTABILITY', message, { cause: err });
      }
      return new DbError('INTERNAL', message, { cause: err });
    default:
      return new DbError('INTERNAL', message, { cause: err });
  }
}

/** Postgres SQLSTATE (5 simvol) daşıyan driver xətası? (ApiError/DomainError kimi tətbiq xətalarından fərqləndirir.) */
export function isPgError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

/** Transaksiya bloku üçün: yalnız DB xətaları xəritələnir, tətbiq xətaları olduğu kimi yayılır. */
export function mapTxError(err: unknown): unknown {
  return err instanceof DbError || !isPgError(err) ? err : mapDbError(err);
}
