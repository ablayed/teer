const SENEGAL_DIAL_CODE = '221';

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

export function normalizeSenegalPhone(value: string): string | null {
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

  return `+${SENEGAL_DIAL_CODE}${digits}`;
}

export function toSenegalNationalDigits(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  return normalizeSenegalPhone(value)?.slice(4) ?? digitsOnly(value).slice(-9);
}
