import { normalizeSenegalPhone, toSenegalNationalDigits } from '@/lib/address/phone-sn';
import { describe, expect, it } from 'vitest';

describe('normalizeSenegalPhone', () => {
  it.each([
    ['77 123 45 67', '+221771234567'],
    ['0771234567', '+221771234567'],
    ['+221 77 123 45 67', '+221771234567'],
    ['00221771234567', '+221771234567'],
  ])('normalizes %s to E.164', (input, expected) => {
    expect(normalizeSenegalPhone(input)).toBe(expected);
  });

  it.each(['123', '+33 1 23 45 67 89', '221123'])('rejects %s', (input) => {
    expect(normalizeSenegalPhone(input)).toBeNull();
  });
});

describe('toSenegalNationalDigits', () => {
  it('returns the editable 9 digit national value', () => {
    expect(toSenegalNationalDigits('+221771234567')).toBe('771234567');
  });
});
