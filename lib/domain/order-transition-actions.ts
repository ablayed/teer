import { type OrderStatus, getAllowedTransitions } from '@/lib/domain/order-state-machine';
import type { TeamRole } from '@/lib/team/permissions';

export const transitionActions = [
  'journaliser_appel',
  'confirmer',
  'programmer',
  'assigner',
  'livrer',
  'annuler',
  'refuser',
] as const;

export type TransitionAction = (typeof transitionActions)[number];

export const paymentChannelsAtDelivery = [
  'ESPECES',
  'WAVE',
  'ORANGE_MONEY',
  'FREE_MONEY',
  'INCONNU',
] as const;

export type PaymentChannelAtDelivery = (typeof paymentChannelsAtDelivery)[number];

type TransitionCatalogItem = {
  action: TransitionAction;
  label: string;
  roles: readonly TeamRole[];
  target: OrderStatus;
};

export const transitionCatalog: readonly TransitionCatalogItem[] = [
  {
    action: 'journaliser_appel',
    label: 'Journaliser une tentative',
    roles: ['owner', 'manager', 'agent'],
    target: 'TENTEE',
  },
  {
    action: 'confirmer',
    label: 'Confirmer',
    roles: ['owner', 'manager', 'agent'],
    target: 'CONFIRMEE',
  },
  {
    action: 'programmer',
    label: 'Programmer la livraison',
    roles: ['owner', 'manager', 'agent'],
    target: 'PROGRAMMEE',
  },
  {
    action: 'assigner',
    label: 'Assigner',
    roles: ['owner', 'manager', 'agent'],
    target: 'EN_LIVRAISON',
  },
  {
    action: 'livrer',
    label: 'Marquer livree',
    roles: ['owner', 'manager'],
    target: 'LIVREE',
  },
  {
    action: 'annuler',
    label: 'Annuler',
    roles: ['owner', 'manager'],
    target: 'ANNULEE',
  },
  {
    action: 'refuser',
    label: 'Refuser',
    roles: ['owner', 'manager'],
    target: 'REFUSEE',
  },
];

export function actionToTarget(action: TransitionAction): OrderStatus {
  return transitionCatalog.find((item) => item.action === action)?.target ?? 'A_APPELER';
}

export function canRolePerformAction(role: TeamRole, action: TransitionAction): boolean {
  return Boolean(transitionCatalog.find((item) => item.action === action)?.roles.includes(role));
}

export function getAllowedTransitionActions(
  status: OrderStatus,
  role: TeamRole,
): TransitionAction[] {
  const allowedTargets = new Set(getAllowedTransitions(status));

  return transitionCatalog
    .filter((item) => allowedTargets.has(item.target) && item.roles.includes(role))
    .map((item) => item.action);
}

export function getTransitionActionForTarget(
  target: OrderStatus,
  role: TeamRole,
): TransitionAction | null {
  return (
    transitionCatalog.find((item) => item.target === target && item.roles.includes(role))?.action ??
    null
  );
}
