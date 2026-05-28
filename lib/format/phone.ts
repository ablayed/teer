export function formatPhoneSN(input: string): string {
  const digits = input.replace(/\D/g, '');
  const national = digits.startsWith('221') && digits.length === 12 ? digits.slice(3) : digits;

  if (!/^\d{9}$/.test(national)) {
    throw new Error('Numéro sénégalais invalide.');
  }

  return `+221 ${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5, 7)} ${national.slice(7, 9)}`;
}
