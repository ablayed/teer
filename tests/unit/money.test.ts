import { formatMoney } from '@/lib/format/fcfa';
import { describe, expect, it } from 'vitest';

describe('formatMoney', () => {
  it('formats XOF with the existing FCFA display', () => {
    expect(formatMoney(12500.7, 'XOF')).toBe('12\u202F501\u202FF CFA');
  });

  it('formats USD with the Shopify currency', () => {
    expect(formatMoney(12500.5, 'USD')).toBe(
      new Intl.NumberFormat('fr-FR', {
        currency: 'USD',
        style: 'currency',
      }).format(12500.5),
    );
  });

  it('formats EUR with the Shopify currency', () => {
    expect(formatMoney(12500.5, 'EUR')).toBe(
      new Intl.NumberFormat('fr-FR', {
        currency: 'EUR',
        style: 'currency',
      }).format(12500.5),
    );
  });

  it.each([null, undefined, ''])('falls back to XOF when currency is %s', (currency) => {
    expect(formatMoney(12500, currency)).toBe('12\u202F500\u202FF CFA');
  });
});
