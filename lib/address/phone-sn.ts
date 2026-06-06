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

// Mobile sénégalais : partie nationale à 9 chiffres commençant par 7 (forme « 7x »). On ne code
// PAS l'opérateur en dur (portabilité depuis 2015 + réallocation). Validation SÉPARÉE de
// normalizeSenegalPhone, qui garde volontairement les fixes (33…) — un fixe n'est pas un mobile.
export function isSenegalMobile(value: string | null | undefined): boolean {
  const e164 = normalizeSenegalPhone(value ?? '');
  if (!e164) {
    return false;
  }
  return e164.slice(4).startsWith('7');
}

export function toSenegalNationalDigits(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  return normalizeSenegalPhone(value)?.slice(4) ?? digitsOnly(value).slice(-9);
}
