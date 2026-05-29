import { formatFCFA, formatFCFACompact } from '@/lib/format/fcfa';
import { describe, expect, it } from 'vitest';

describe('formatFCFA', () => {
  it.each([
    [0, '0\u202FF CFA'],
    [500, '500\u202FF CFA'],
    [12500, '12\u202F500\u202FF CFA'],
    [1000000, '1\u202F000\u202F000\u202FF CFA'],
    [-12500, '-12\u202F500\u202FF CFA'],
    [12500.7, '12\u202F501\u202FF CFA'],
    [12500.4, '12\u202F500\u202FF CFA'],
  ])('formats %s correctly', (input, expected) => {
    expect(formatFCFA(input)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects invalid amount %s',
    (input) => {
      expect(() => formatFCFA(input)).toThrow(new RangeError('formatFCFA: invalid amount'));
    },
  );
});

describe('formatFCFACompact', () => {
  it.each([
    [999, '999\u202FF CFA'],
    [12500, '12,5 k F CFA'],
    [1500000, '1,5 M F CFA'],
    [2000000, '2 M F CFA'],
    [-1500000, '-1,5 M F CFA'],
  ])('formats compact amount %s correctly', (input, expected) => {
    expect(formatFCFACompact(input)).toBe(expected);
  });

  it('rejects invalid compact amounts', () => {
    expect(() => formatFCFACompact(Number.NaN)).toThrow(
      new RangeError('formatFCFA: invalid amount'),
    );
  });
});
