import { z } from 'zod';
import { DbError } from './db/errors.js';
import { DomainError } from './domain/index.js';

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'APPROVAL_REQUIRED',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  APPROVAL_REQUIRED: 409,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL: 500,
};

/** `{ error: { code, message, requestId } }` (BACKEND.md §5). */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    requestId: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export class ApiError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    statusCode?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode ?? STATUS_BY_CODE[code];
  }

  static unauthenticated(msg = 'Authentication required') {
    return new ApiError('UNAUTHENTICATED', msg);
  }
  static forbidden(msg = 'Forbidden') {
    return new ApiError('FORBIDDEN', msg);
  }
  static notFound(msg = 'Not found') {
    return new ApiError('NOT_FOUND', msg);
  }
  static validation(msg: string, statusCode?: number) {
    return new ApiError('VALIDATION_FAILED', msg, statusCode);
  }
  static conflict(msg: string) {
    return new ApiError('CONFLICT', msg);
  }
  static approvalRequired(msg: string) {
    return new ApiError('APPROVAL_REQUIRED', msg);
  }
  static rateLimited(msg: string) {
    return new ApiError('RATE_LIMITED', msg);
  }
  static upstream(msg: string) {
    return new ApiError('UPSTREAM_UNAVAILABLE', msg);
  }
  static internal(msg = 'Internal server error') {
    return new ApiError('INTERNAL', msg);
  }
}

/** Route `response` sxemləri üçün: verilmiş status kodlarının hamısı eyni xəta formatındadır. */
export function errorResponses<
  const S extends readonly (400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 503)[],
>(...statuses: S): Record<S[number], typeof ErrorResponseSchema> {
  return Object.fromEntries(statuses.map((s) => [s, ErrorResponseSchema])) as Record<
    S[number],
    typeof ErrorResponseSchema
  >;
}

/** Domain/DB xətalarını API xətasına çevirir. A-13: naməlum/DB xətası → 5xx, detal sızdırılmır. */
export function toApiError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err;
  if (err instanceof DomainError) {
    switch (err.kind) {
      case 'INVALID_STATE_TRANSITION':
      case 'CONFLICT':
        return ApiError.conflict(err.message);
      case 'SELF_APPROVAL_FORBIDDEN':
      case 'FORBIDDEN':
        return ApiError.forbidden(err.message);
      case 'NOT_FOUND':
        return ApiError.notFound(err.message);
      case 'VALIDATION':
        return ApiError.validation(err.message);
      case 'UNAUTHORIZED':
        return ApiError.unauthenticated(err.message);
    }
  }
  if (err instanceof DbError) {
    switch (err.kind) {
      case 'NOT_FOUND':
        return ApiError.notFound(err.message);
      case 'CONFLICT':
      case 'CONSTRAINT':
      case 'IMMUTABILITY':
        return ApiError.conflict(err.message);
      case 'INTERNAL':
        return null;
    }
  }
  return null;
}
