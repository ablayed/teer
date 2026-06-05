const NARROW_NO_BREAK_SPACE = '\u202F';

function assertValidAmount(amount: number) {
  if (!Number.isFinite(amount)) {
    throw new RangeError('formatFCFA: invalid amount');
  }
}

function formatRoundedNumber(amount: number): string {
  return new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
    useGrouping: true,
  }).format(Math.round(amount));
}

export function formatFCFA(amount: number): string {
  assertValidAmount(amount);

  return `${formatRoundedNumber(amount)}${NARROW_NO_BREAK_SPACE}F CFA`;
}

// Tëër est mono-devise FCFA à l'affichage : on ignore volontairement la devise
// stockée (multi-devise différé à un futur marché hors zone CFA). La signature
// conserve le paramètre `currency` pour ne pas casser les appelants et faciliter
// un éventuel retour au multi-devise, mais il n'est plus utilisé.
export function formatMoney(amount: number, _currency?: string | null): string {
  return formatFCFA(amount);
}

export function formatFCFACompact(amount: number): string {
  assertValidAmount(amount);

  const absoluteAmount = Math.abs(amount);

  if (absoluteAmount < 1_000) {
    return formatFCFA(amount);
  }

  const divisor = absoluteAmount >= 1_000_000 ? 1_000_000 : 1_000;
  const suffix = absoluteAmount >= 1_000_000 ? 'M' : 'k';
  const compactValue = amount / divisor;
  const formatted = new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  }).format(compactValue);

  return `${formatted} ${suffix} F CFA`;
}
