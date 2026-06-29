const SENEGAL_DIAL_CODE = '221';
const MOBILE_PREFIXES = ['70', '75', '76', '77', '78', '79'] as const;

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

export function normalizeWhatsAppSenegalPhone(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  let digits = digitsOnly(value.trim());

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.startsWith(SENEGAL_DIAL_CODE)) {
    digits = digits.slice(SENEGAL_DIAL_CODE.length);
  }

  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (!/^\d{9}$/.test(digits)) {
    return null;
  }

  if (!MOBILE_PREFIXES.some((prefix) => digits.startsWith(prefix))) {
    return null;
  }

  return `${SENEGAL_DIAL_CODE}${digits}`;
}
