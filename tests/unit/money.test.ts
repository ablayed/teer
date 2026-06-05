import { formatFCFA, formatMoney } from '@/lib/format/fcfa';
import { describe, expect, it } from 'vitest';

describe('formatMoney (mono-devise FCFA)', () => {
  it('formats XOF with the FCFA display', () => {
    expect(formatMoney(12500.7, 'XOF')).toBe(formatFCFA(12500.7));
  });

  it('forces FCFA even when the stored currency is USD', () => {
    expect(formatMoney(12500.5, 'USD')).toBe(formatFCFA(12500.5));
  });

  it('forces FCFA even when the stored currency is EUR', () => {
    expect(formatMoney(12500.5, 'EUR')).toBe(formatFCFA(12500.5));
  });

  it.each([null, undefined, ''])('forces FCFA when currency is %s', (currency) => {
    expect(formatMoney(12500, currency)).toBe(formatFCFA(12500));
  });
});
