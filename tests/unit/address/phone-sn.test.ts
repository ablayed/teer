import {
  isSenegalMobile,
  normalizeSenegalPhone,
  toSenegalNationalDigits,
} from '@/lib/address/phone-sn';
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

describe('isSenegalMobile (forme 7x, séparée de la normalisation)', () => {
  it.each(['771234567', '0781234567', '+221 76 123 45 67', '00221701234567'])(
    'accepte le mobile 7x %s',
    (input) => {
      expect(isSenegalMobile(input)).toBe(true);
    },
  );

  it.each(['331234567', '+221331234567'])(
    'rejette le fixe 33 %s (gardé mais pas mobile)',
    (input) => {
      expect(isSenegalMobile(input)).toBe(false);
    },
  );

  it.each(['123', '', null, undefined])('rejette l_invalide %s', (input) => {
    expect(isSenegalMobile(input)).toBe(false);
  });
});

describe('toSenegalNationalDigits', () => {
  it('returns the editable 9 digit national value', () => {
    expect(toSenegalNationalDigits('+221771234567')).toBe('771234567');
  });
});
