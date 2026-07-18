export const orderStatuses = [
  'A_APPELER',
  'TENTEE',
  'CONFIRMEE',
  'PROGRAMMEE',
  'EN_LIVRAISON',
  'LIVREE',
  'REFUSEE',
  'ANNULEE',
] as const;

export type OrderStatus = (typeof orderStatuses)[number];

export const orderStatusLabels: Record<OrderStatus, string> = {
  A_APPELER: '\u00c0 appeler',
  TENTEE: 'Tent\u00e9e',
  CONFIRMEE: 'Confirm\u00e9e',
  PROGRAMMEE: 'Programm\u00e9e',
  EN_LIVRAISON: 'En livraison',
  LIVREE: 'Livr\u00e9e',
  REFUSEE: 'Refus\u00e9e',
  ANNULEE: 'Annul\u00e9e',
};

const legalTransitions: Record<OrderStatus, readonly OrderStatus[]> = {
  // Phase 11 : PROGRAMMEE ajoutée comme cible directe (action « programmer » =
  // confirmation + programmation fusionnées depuis « À appeler »/« Tentée »).
  A_APPELER: ['TENTEE', 'CONFIRMEE', 'PROGRAMMEE', 'REFUSEE', 'ANNULEE'],
  TENTEE: ['TENTEE', 'CONFIRMEE', 'PROGRAMMEE', 'REFUSEE', 'ANNULEE', 'A_APPELER'],
  CONFIRMEE: ['PROGRAMMEE', 'ANNULEE', 'REFUSEE'],
  PROGRAMMEE: ['EN_LIVRAISON', 'ANNULEE', 'REFUSEE'],
  // Phase 11.1 (option C) : EN_LIVRAISON→EN_LIVRAISON autorisé pour l'étape
  // `demarrer_livraison` (assigned→out_for_delivery). Le cod_status legacy reste
  // EN_LIVRAISON pour les deux dimensions ; seul delivery_state change.
  // « Refuser → Reprogrammer » : REFUSEE retirée (« refuser » n'est plus légal
  // depuis assigned/out_for_delivery, cf. getAllowedTransitionActionsForDimensions),
  // PROGRAMMEE ajoutée (nouvelle action « reprogrammer »).
  EN_LIVRAISON: ['EN_LIVRAISON', 'LIVREE', 'PROGRAMMEE', 'ANNULEE'],
  LIVREE: [],
  REFUSEE: [],
  ANNULEE: [],
};

export class IllegalTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Transition COD impossible : ${orderStatusLabels[from]} vers ${orderStatusLabels[to]}.`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return legalTransitions[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}

export function getAllowedTransitions(from: OrderStatus): OrderStatus[] {
  return [...legalTransitions[from]];
}

export function isTerminal(status: OrderStatus): boolean {
  return getAllowedTransitions(status).length === 0;
}
