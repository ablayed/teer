const SENEGAL_COUNTRY_CODE = '221';
const MOBILE_PREFIXES = ['70', '75', '76', '77', '78'] as const;

function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, '');
}

function nationalDigits(raw: string): string | null {
  const digits = digitsOnly(raw);
  const withoutInternationalPrefix = digits.startsWith('00') ? digits.slice(2) : digits;

  if (withoutInternationalPrefix.startsWith(SENEGAL_COUNTRY_CODE)) {
    return withoutInternationalPrefix.slice(SENEGAL_COUNTRY_CODE.length);
  }

  return withoutInternationalPrefix;
}

function isNineDigits(value: string): boolean {
  return /^\d{9}$/.test(value);
}

export function formatPhoneSN(raw: string): string {
  const trimmed = raw.trim();
  const national = nationalDigits(trimmed);

  if (!national || !isNineDigits(national)) {
    return trimmed;
  }

  return `+221 ${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5, 7)} ${national.slice(7, 9)}`;
}

export function isValidPhoneSN(raw: string): boolean {
  const national = nationalDigits(raw.trim());

  return (
    national !== null &&
    isNineDigits(national) &&
    MOBILE_PREFIXES.some((prefix) => national.startsWith(prefix))
  );
}

export function toWhatsAppLink(raw: string): string {
  const national = nationalDigits(raw.trim());

  if (national && isNineDigits(national)) {
    return `https://wa.me/${SENEGAL_COUNTRY_CODE}${national}`;
  }

  return `https://wa.me/${digitsOnly(raw)}`;
}
