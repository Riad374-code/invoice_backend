import { Decimal } from 'decimal.js';
import { D, type Dec } from './money.js';

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'UP' | 'DOWN';
/** `line`: hər sətir ayrıca yuvarlaqlaşdırılır, cəm yuvarlaq sətirlərin cəmidir. `total`: cəm bir dəfə yuvarlaqlaşdırılır. */
export type RoundingLevel = 'line' | 'total';

export interface RoundingRule {
  mode: RoundingMode;
  /** Onluq rəqəm sayı (AZN üçün 2 = qəpik). */
  scale: number;
  level: RoundingLevel;
}

const MODE: Record<RoundingMode, Decimal.Rounding> = {
  HALF_UP: Decimal.ROUND_HALF_UP, // 0.5 → sıfırdan uzaq tərəfə (mənfi məbləğlərdə simmetrik)
  HALF_EVEN: Decimal.ROUND_HALF_EVEN, // "bankir" yuvarlaqlaşdırması
  UP: Decimal.ROUND_UP,
  DOWN: Decimal.ROUND_DOWN,
};

export function round(value: Dec, rule: Pick<RoundingRule, 'mode' | 'scale'>): Dec {
  return new D(value.toDecimalPlaces(rule.scale, MODE[rule.mode]));
}

export const DEFAULT_ROUNDING: RoundingRule = { mode: 'HALF_UP', scale: 2, level: 'line' };

/**
 * Yuvarlaqlaşdırma yurisdiksiyaya görə konfiqurasiya olunur (§6.1). Yeni yurisdiksiya əlavə etmək
 * kod dəyişikliyi deyil, bu cədvəlin (və ya gələcəkdə DB konfiqinin) dəyişməsidir.
 */
export const ROUNDING_BY_JURISDICTION: Readonly<Record<string, RoundingRule>> = {
  AZ: DEFAULT_ROUNDING,
};

export function roundingFor(jurisdiction = 'AZ'): RoundingRule {
  return ROUNDING_BY_JURISDICTION[jurisdiction] ?? DEFAULT_ROUNDING;
}
