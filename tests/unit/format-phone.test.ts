import { formatPhoneSN } from '@/lib/format/phone';
import { describe, expect, it } from 'vitest';

describe('formatPhoneSN', () => {
  it.each([
    ['771234567', '+221 77 123 45 67'],
    ['+221 77 123 45 67', '+221 77 123 45 67'],
    ['221781112233', '+221 78 111 22 33'],
  ])('formats %s correctly', (input, expected) => {
    expect(formatPhoneSN(input)).toBe(expected);
  });

  it('rejects invalid numbers', () => {
    expect(() => formatPhoneSN('123')).toThrow('Numéro sénégalais invalide.');
  });
});
