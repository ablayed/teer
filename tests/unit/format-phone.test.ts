import { formatPhoneSN, isValidPhoneSN, toWhatsAppLink } from '@/lib/format/phone';
import { describe, expect, it } from 'vitest';

describe('formatPhoneSN', () => {
  it.each([
    ['771234567', '+221 77 123 45 67'],
    ['+221771234567', '+221 77 123 45 67'],
    ['00221771234567', '+221 77 123 45 67'],
    ['77 123 45 67', '+221 77 123 45 67'],
    ['77-123-45-67', '+221 77 123 45 67'],
    ['+221 78 111 22 33', '+221 78 111 22 33'],
  ])('formats %s correctly', (input, expected) => {
    expect(formatPhoneSN(input)).toBe(expected);
  });

  it.each([
    ['123', '123'],
    ['+33 1 23 45 67 89', '+33 1 23 45 67 89'],
    ['  invalid phone  ', 'invalid phone'],
  ])('returns trimmed raw value for invalid or foreign number %s', (input, expected) => {
    expect(formatPhoneSN(input)).toBe(expected);
  });
});

describe('isValidPhoneSN', () => {
  it.each(['701234567', '751234567', '761234567', '771234567', '781234567'])(
    'accepts valid mobile prefix %s',
    (input) => {
      expect(isValidPhoneSN(input)).toBe(true);
    },
  );

  it.each(['331234567', '77123456', '+33 1 23 45 67 89', '221331234567'])(
    'rejects invalid mobile number %s',
    (input) => {
      expect(isValidPhoneSN(input)).toBe(false);
    },
  );
});

describe('toWhatsAppLink', () => {
  it.each([
    ['771234567', 'https://wa.me/221771234567'],
    ['+221 77 123 45 67', 'https://wa.me/221771234567'],
    ['00221771234567', 'https://wa.me/221771234567'],
  ])('builds wa.me link for %s', (input, expected) => {
    expect(toWhatsAppLink(input)).toBe(expected);
  });
});
