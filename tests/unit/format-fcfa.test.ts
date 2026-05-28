import { formatFCFA } from '@/lib/format/fcfa';
import { describe, expect, it } from 'vitest';

describe('formatFCFA', () => {
  it.each([
    [0, '0\u202FF\u202FCFA'],
    [500, '500\u202FF\u202FCFA'],
    [12500, '12\u202F500\u202FF\u202FCFA'],
    [1000000, '1\u202F000\u202F000\u202FF\u202FCFA'],
  ])('formats %i correctly', (input, expected) => {
    expect(formatFCFA(input)).toBe(expected);
  });
});
