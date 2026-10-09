export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface Job {
  id: string;
  companyId: string | null;
  queue: string;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  lastError: string | null;
  result: unknown;
  idempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

/** Eksponensial geri çəkilmə: 5s, 20s, 80s, … (üst hədd 15 dəq). */
export function retryDelayMs(attempt: number): number {
  return Math.min(5_000 * 4 ** Math.max(0, attempt - 1), 15 * 60_000);
}
