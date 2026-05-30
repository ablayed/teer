export const codStatuses = [
  'nouvelle',
  'confirmee',
  'assignee',
  'en_livraison',
  'livree',
  'annulee',
  'retournee',
] as const;

export type CodStatus = (typeof codStatuses)[number];

export function isCodStatus(value: string): value is CodStatus {
  return codStatuses.includes(value as CodStatus);
}
