/* eslint-disable no-restricted-syntax -- calendar parts are small integers, never money */
import { AccountingError } from './errors.js';

/** Təqvim günü, `YYYY-MM-DD` (saat qurşağı problemi yoxdur). */
export type LocalDate = string;

const PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLocalDate(value: string): boolean {
  const m = PATTERN.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function assertLocalDate(value: string, label = 'date'): LocalDate {
  if (!isLocalDate(value)) {
    throw new AccountingError('INVALID_DATE', `${label} "${value}" is not a valid YYYY-MM-DD date`);
  }
  return value;
}

/** Leksikoqrafik müqayisə YYYY-MM-DD üçün düzgündür. */
export function compareDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const DAY_MS = 86_400_000;
const toMs = (d: LocalDate) => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, day);
};

export function addDays(date: LocalDate, days: number): LocalDate {
  return new Date(toMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** `to - from` gün fərqi. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return (toMs(to) - toMs(from)) / DAY_MS; // UTC gecə yarısı → tam bölünür
}
