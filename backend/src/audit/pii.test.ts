import { describe, expect, it } from 'vitest';
import { maskJsonValue, maskText } from './pii.js';

describe('PII masking', () => {
  it('masks VÖEN (10 digits)', () => {
    expect(maskText('Company VOEN is 1234567890 for taxpayer')).toBe(
      'Company VOEN is 1234****90 for taxpayer',
    );
  });

  it('masks AZ IBAN', () => {
    expect(maskText('Account: AZ21NABZ01350100000000000106 please transfer')).toBe(
      'Account: AZ21NABZ****************0106 please transfer',
    );
  });

  it('masks Azerbaijani phone numbers', () => {
    const masked = maskText('Call +994501234567 or 0559876543');
    expect(masked).toContain('(050)***-**-67');
    expect(masked).toContain('(055)***-**-43');
  });

  it('masks nested JSON, FIN and secrets', () => {
    const masked = maskJsonValue({
      company_name: 'Test MMC',
      voen: '1234567890',
      fin: '12ABC78',
      password: 'super-secret-pass',
      nested: [{ account: 'AZ21NABZ01350100000000000106' }],
      amount: 5,
    }) as Record<string, unknown>;
    expect(masked['voen']).toBe('1234****90');
    expect(masked['fin']).toBe('12***78');
    expect(masked['password']).toBe('[REDACTED]');
    expect(masked['nested']).toEqual([{ account: 'AZ21NABZ****************0106' }]);
    expect(masked['amount']).toBe(5);
  });

  it('does not mutate its input', () => {
    const input = { voen: '1234567890' };
    maskJsonValue(input);
    expect(input.voen).toBe('1234567890');
  });
});
