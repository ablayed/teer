export function formatFCFA(amount: number): string {
  const formatted = new Intl.NumberFormat('fr-FR', {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).format(amount);
  return `${formatted}\u202FF\u202FCFA`;
}
