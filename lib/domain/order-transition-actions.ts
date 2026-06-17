import { type OrderStatus, orderStatuses } from '@/lib/domain/order-state-machine';
import type { TeamRole } from '@/lib/team/permissions';

export const transitionActions = [
  'journaliser_appel',
  'confirmer',
  'programmer',
  'assigner',
  'demarrer_livraison',
  'livrer',
  'mark_returned',
  'annuler',
  'refuser',
  'deconfirmer',
  'desannuler',
] as const;

export type TransitionAction = (typeof transitionActions)[number];

// Lot B : liste fixe (allow-list) des raisons d'annulation. Validée côté serveur
// en Zod ; PAS de CHECK en base (la liste peut évoluer). « autres » → note libre.
export const cancelReasonValues = [
  'indisponibilite',
  'prix',
  'concurrence',
  'erreur',
  'refus',
  'autres',
] as const;

export type CancelReason = (typeof cancelReasonValues)[number];

export const cancelReasonLabels: Record<CancelReason, string> = {
  indisponibilite: 'Indisponibilité',
  prix: 'Prix trop élevé',
  concurrence: 'Trouvé moins cher ailleurs',
  erreur: 'Commande par erreur',
  refus: 'Refus',
  autres: 'Autres',
};

export function isCancelReason(value: string): value is CancelReason {
  return cancelReasonValues.includes(value as CancelReason);
}

export const paymentChannelsAtDelivery = [
  'ESPECES',
  'WAVE',
  'ORANGE_MONEY',
  'FREE_MONEY',
  'INCONNU',
] as const;

export type PaymentChannelAtDelivery = (typeof paymentChannelsAtDelivery)[number];

export const orderStates = ['open', 'completed', 'cancelled', 'returned'] as const;
export const callStates = ['to_call', 'callback', 'validated', 'unreachable'] as const;
export const deliveryStates = [
  'unassigned',
  'scheduled',
  'assigned',
  'out_for_delivery',
  'delivered',
  'failed',
  'returned',
] as const;
export const cashStates = ['not_due', 'expected', 'collected', 'remitted', 'discrepancy'] as const;

export type OrderStateDimension = (typeof orderStates)[number];
export type CallStateDimension = (typeof callStates)[number];
export type DeliveryStateDimension = (typeof deliveryStates)[number];
export type CashStateDimension = (typeof cashStates)[number];

export type OrderDimensions = {
  assignedDriverId: string | null;
  attemptCount: number;
  callState: CallStateDimension;
  cancelReason: string | null;
  cashState: CashStateDimension;
  codStatus: string;
  deliveryState: DeliveryStateDimension;
  nextContactAt: string | null;
  orderState: OrderStateDimension;
  scheduledFor: string | null;
};

export type OrderDimensionsSource = {
  assigned_driver_id?: string | null;
  attempt_count?: number | null;
  call_state?: string | null;
  cancel_reason?: string | null;
  cash_state?: string | null;
  cod_status?: string | null;
  delivery_state?: string | null;
  next_contact_at?: string | null;
  order_state?: string | null;
  scheduled_for?: string | null;
};

export type TransitionSupportPayload = {
  assignedDriverId?: string;
  cancelReason?: string;
  cancelReasons?: string[];
  nextContactAt?: string;
  paymentChannelAtDelivery?: PaymentChannelAtDelivery;
  scheduledFor?: string;
};

export type TransitionDimensionPatch = {
  assignedDriverId?: string;
  attemptCount?: number;
  callState?: CallStateDimension;
  cancelReason?: string;
  cancelReasons?: string[];
  cashState?: CashStateDimension;
  // Lot B : effacements explicites (le RPC ne peut sinon que coalesce, jamais NULL).
  clearCancelReasons?: boolean;
  clearScheduledFor?: boolean;
  deliveryState?: DeliveryStateDimension;
  nextContactAt?: string;
  orderState?: OrderStateDimension;
  paymentChannelAtDelivery?: PaymentChannelAtDelivery;
  scheduledFor?: string;
};

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
  // Phase 11.1 (option C) : démarrer la livraison = assigned → out_for_delivery.
  // target EN_LIVRAISON (legacy inchangé) MAIS exclue de getTransitionActionForTarget
  // (sinon « EN_LIVRAISON » via target deviendrait ambigu avec « assigner »).
  // Déclenchée explicitement par nom (popup d'assignation + dropdown).
  {
    action: 'demarrer_livraison',
    label: 'Démarrer la livraison',
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
    action: 'mark_returned',
    label: 'Marquer retournée',
    roles: ['owner', 'manager'],
    target: 'REFUSEE',
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
  // Lot B — actions reverse. target A_APPELER : volontairement exclues de
  // getTransitionActionForTarget (sinon « A_APPELER » deviendrait actionnable
  // par les chemins inline status). Légalité gérée par dimensions, pas par target.
  {
    action: 'deconfirmer',
    label: 'Déconfirmer',
    roles: ['owner', 'manager', 'agent'],
    target: 'A_APPELER',
  },
  {
    action: 'desannuler',
    label: 'Désannuler',
    roles: ['owner', 'manager'],
    target: 'A_APPELER',
  },
];

function isOrderStatus(value: string | null | undefined): value is OrderStatus {
  return Boolean(value && orderStatuses.includes(value as OrderStatus));
}

function isOrderStateDimension(value: string | null | undefined): value is OrderStateDimension {
  return Boolean(value && orderStates.includes(value as OrderStateDimension));
}

function isCallStateDimension(value: string | null | undefined): value is CallStateDimension {
  return Boolean(value && callStates.includes(value as CallStateDimension));
}

function isDeliveryStateDimension(
  value: string | null | undefined,
): value is DeliveryStateDimension {
  return Boolean(value && deliveryStates.includes(value as DeliveryStateDimension));
}

function isCashStateDimension(value: string | null | undefined): value is CashStateDimension {
  return Boolean(value && cashStates.includes(value as CashStateDimension));
}

export function legacyStatusToDimensions(status: OrderStatus): OrderDimensions {
  switch (status) {
    case 'A_APPELER':
      return {
        assignedDriverId: null,
        attemptCount: 0,
        callState: 'to_call',
        cancelReason: null,
        cashState: 'not_due',
        codStatus: status,
        deliveryState: 'unassigned',
        nextContactAt: null,
        orderState: 'open',
        scheduledFor: null,
      };
    case 'TENTEE':
      return {
        assignedDriverId: null,
        attemptCount: 1,
        callState: 'callback',
        cancelReason: null,
        cashState: 'not_due',
        codStatus: status,
        deliveryState: 'unassigned',
        nextContactAt: null,
        orderState: 'open',
        scheduledFor: null,
      };
    case 'CONFIRMEE':
      return {
        assignedDriverId: null,
        attemptCount: 0,
        callState: 'validated',
        cancelReason: null,
        cashState: 'not_due',
        codStatus: status,
        deliveryState: 'unassigned',
        nextContactAt: null,
        orderState: 'open',
        scheduledFor: null,
      };
    case 'PROGRAMMEE':
      return {
        assignedDriverId: null,
        attemptCount: 0,
        callState: 'validated',
        cancelReason: null,
        cashState: 'expected',
        codStatus: status,
        deliveryState: 'scheduled',
        nextContactAt: null,
        orderState: 'open',
        scheduledFor: null,
      };
    case 'EN_LIVRAISON':
      return {
        assignedDriverId: null,
        attemptCount: 0,
        callState: 'validated',
        cancelReason: null,
        cashState: 'expected',
        codStatus: status,
        deliveryState: 'assigned',
        nextContactAt: null,
        orderState: 'open',
        scheduledFor: null,
      };
    case 'LIVREE':
      return {
        assignedDriverId: null,
        attemptCount: 0,
        callState: 'validated',
        cancelReason: null,
        cashState: 'collected',
        codStatus: status,
        deliveryState: 'delivered',
        nextContactAt: null,
        orderState: 'completed',
        scheduledFor: null,
      };
    case 'REFUSEE':
      return {
        assignedDriverId: null,
        attemptCount: 0,
        callState: 'validated',
        cancelReason: 'refused',
        cashState: 'not_due',
        codStatus: status,
        deliveryState: 'failed',
        nextContactAt: null,
        orderState: 'cancelled',
        scheduledFor: null,
      };
    case 'ANNULEE':
      return {
        assignedDriverId: null,
        attemptCount: 0,
        callState: 'validated',
        cancelReason: 'cancelled',
        cashState: 'not_due',
        codStatus: status,
        deliveryState: 'unassigned',
        nextContactAt: null,
        orderState: 'cancelled',
        scheduledFor: null,
      };
  }
}

export function deriveLegacyStatusFromDimensions(
  dimensions: Pick<OrderDimensions, 'callState' | 'cashState' | 'deliveryState' | 'orderState'>,
): OrderStatus {
  if (dimensions.deliveryState === 'failed' || dimensions.deliveryState === 'returned') {
    return 'REFUSEE';
  }

  if (dimensions.orderState === 'returned') {
    return 'REFUSEE';
  }

  if (dimensions.orderState === 'cancelled') {
    return 'ANNULEE';
  }

  if (dimensions.deliveryState === 'delivered') {
    return 'LIVREE';
  }

  if (dimensions.deliveryState === 'out_for_delivery' || dimensions.deliveryState === 'assigned') {
    return 'EN_LIVRAISON';
  }

  if (dimensions.deliveryState === 'scheduled') {
    return 'PROGRAMMEE';
  }

  if (dimensions.callState === 'validated') {
    return 'CONFIRMEE';
  }

  if (dimensions.callState === 'callback') {
    return 'TENTEE';
  }

  return 'A_APPELER';
}

export function resolveOrderDimensions(source: OrderDimensionsSource): OrderDimensions {
  const fallbackStatus = isOrderStatus(source.cod_status) ? source.cod_status : 'A_APPELER';
  const fallbackDimensions = legacyStatusToDimensions(fallbackStatus);
  const orderState = isOrderStateDimension(source.order_state)
    ? source.order_state
    : fallbackDimensions.orderState;
  const callState = isCallStateDimension(source.call_state)
    ? source.call_state
    : fallbackDimensions.callState;
  const deliveryState = isDeliveryStateDimension(source.delivery_state)
    ? source.delivery_state
    : fallbackDimensions.deliveryState;
  const cashState = isCashStateDimension(source.cash_state)
    ? source.cash_state
    : fallbackDimensions.cashState;
  const dimensions: OrderDimensions = {
    assignedDriverId: source.assigned_driver_id ?? fallbackDimensions.assignedDriverId,
    attemptCount: source.attempt_count ?? fallbackDimensions.attemptCount,
    callState,
    cancelReason: source.cancel_reason ?? fallbackDimensions.cancelReason,
    cashState,
    codStatus: deriveLegacyStatusFromDimensions({
      callState,
      cashState,
      deliveryState,
      orderState,
    }),
    deliveryState,
    nextContactAt: source.next_contact_at ?? fallbackDimensions.nextContactAt,
    orderState,
    scheduledFor: source.scheduled_for ?? fallbackDimensions.scheduledFor,
  };

  return dimensions;
}

export function getAllowedTransitionActionsForDimensions(
  dimensions: Pick<OrderDimensions, 'callState' | 'deliveryState' | 'orderState'>,
  role: TeamRole,
): TransitionAction[] {
  if (dimensions.orderState !== 'open') {
    if (dimensions.orderState === 'completed' && dimensions.deliveryState === 'delivered') {
      return transitionCatalog
        .filter((item) => item.action === 'mark_returned' && item.roles.includes(role))
        .map((item) => item.action);
    }

    // Lot B : désannuler est la SEULE action légale sur une commande annulée,
    // ET uniquement pré-dispatch (delivery unassigned/scheduled). Une livraison
    // échouée (REFUSEE : order_state=cancelled MAIS delivery_state=failed, stock
    // chez le livreur) n'est PAS rouvrable ici — ni les retours terminaux. Géré
    // avant le filtrage « open » du catalogue.
    if (
      dimensions.orderState === 'cancelled' &&
      (dimensions.deliveryState === 'unassigned' || dimensions.deliveryState === 'scheduled')
    ) {
      return transitionCatalog
        .filter((item) => item.action === 'desannuler' && item.roles.includes(role))
        .map((item) => item.action);
    }
    return [];
  }

  return transitionCatalog
    .filter((item) => item.roles.includes(role))
    .filter((item) => {
      switch (item.action) {
        case 'desannuler':
          // Jamais légale sur une commande ouverte (gérée ci-dessus).
          return false;
        case 'mark_returned':
          // Jamais légale sur une commande ouverte : cas spécial completed/delivered ci-dessus.
          return false;
        case 'deconfirmer':
          return (
            dimensions.callState === 'validated' &&
            (dimensions.deliveryState === 'unassigned' || dimensions.deliveryState === 'scheduled')
          );
        case 'journaliser_appel':
          return (
            dimensions.deliveryState === 'unassigned' &&
            (dimensions.callState === 'to_call' || dimensions.callState === 'callback')
          );
        case 'confirmer':
          return (
            dimensions.deliveryState === 'unassigned' &&
            (dimensions.callState === 'to_call' || dimensions.callState === 'callback')
          );
        case 'programmer':
          // Phase 11 : « programmer » fusionne confirmation + programmation.
          // Légale dès « À appeler »/« Tentée » (to_call/callback) ET depuis une
          // commande déjà confirmée (validated), tant que le stock est en entrepôt
          // (unassigned). buildTransitionDimensionPatch pose validated+scheduled.
          return (
            (dimensions.callState === 'to_call' ||
              dimensions.callState === 'callback' ||
              dimensions.callState === 'validated') &&
            dimensions.deliveryState === 'unassigned'
          );
        case 'assigner':
          return dimensions.callState === 'validated' && dimensions.deliveryState === 'scheduled';
        case 'demarrer_livraison':
          // Phase 11.1 : assigned (livreur affecté) → out_for_delivery.
          return dimensions.callState === 'validated' && dimensions.deliveryState === 'assigned';
        case 'livrer':
          return (
            dimensions.callState === 'validated' &&
            (dimensions.deliveryState === 'assigned' ||
              dimensions.deliveryState === 'out_for_delivery')
          );
        case 'annuler':
        case 'refuser':
          return dimensions.deliveryState !== 'delivered';
      }
    })
    .map((item) => item.action);
}

// Phase 11 : « programmer » remplace « confirmer » dans les surfaces d'action
// (dropdown, kanban). confirmer reste légale au niveau moteur (chemins inline par
// target via getTransitionActionForTarget, rétro-compat CONFIRMEE) mais n'est
// jamais proposée à l'utilisateur quand programmer l'est — et programmer l'est
// dans TOUS les états où confirmer l'est (to_call/callback + unassigned).
export function visibleAllowedActions(actions: TransitionAction[]): TransitionAction[] {
  // Phase 11.1 : « demarrer_livraison » n'est JAMAIS une entrée de dropdown — elle
  // est déclenchée uniquement par le popup d'assignation (save + démarrage).
  const withoutStart = actions.filter((action) => action !== 'demarrer_livraison');
  if (!withoutStart.includes('programmer')) {
    return withoutStart;
  }
  return withoutStart.filter((action) => action !== 'confirmer');
}

export function buildTransitionDimensionPatch(
  action: TransitionAction,
  dimensions: OrderDimensions,
  payload: TransitionSupportPayload = {},
): TransitionDimensionPatch {
  switch (action) {
    case 'journaliser_appel':
      return {
        attemptCount: dimensions.attemptCount + 1,
        callState: 'callback',
        ...(payload.nextContactAt ? { nextContactAt: payload.nextContactAt } : {}),
      };
    case 'confirmer':
      return {
        callState: 'validated',
      };
    case 'programmer':
      return {
        callState: 'validated',
        cashState: 'expected',
        deliveryState: 'scheduled',
        ...(payload.scheduledFor ? { scheduledFor: payload.scheduledFor } : {}),
      };
    case 'assigner':
      return {
        callState: 'validated',
        cashState: 'expected',
        deliveryState: 'assigned',
        ...(payload.assignedDriverId ? { assignedDriverId: payload.assignedDriverId } : {}),
      };
    // Phase 11.1 (option C) : démarrer la livraison. Seul delivery_state change
    // (assigned→out_for_delivery). AUCUN mouvement stock (dispatch déjà posté à
    // l'assignation ; le garde SQL exclut assigned du re-dispatch). cash reste
    // expected, call reste validated, livreur inchangé.
    case 'demarrer_livraison':
      return {
        deliveryState: 'out_for_delivery',
      };
    case 'livrer':
      return {
        callState: 'validated',
        cashState: 'collected',
        deliveryState: 'delivered',
        orderState: 'completed',
        paymentChannelAtDelivery: payload.paymentChannelAtDelivery ?? 'ESPECES',
      };
    case 'mark_returned':
      return {
        cashState: 'not_due',
        deliveryState: 'returned',
        orderState: 'returned',
      };
    case 'annuler':
      return {
        cashState: 'not_due',
        deliveryState: 'unassigned',
        orderState: 'cancelled',
        cancelReason: payload.cancelReason ?? 'cancelled',
        ...(payload.cancelReasons ? { cancelReasons: payload.cancelReasons } : {}),
      };
    case 'refuser':
      return {
        callState: 'validated',
        cashState: 'not_due',
        deliveryState: 'failed',
        orderState: 'cancelled',
        cancelReason: payload.cancelReason ?? 'refused',
      };
    // Lot B — déconfirmer : reverse strict de confirmer/programmer. call→to_call,
    // delivery scheduled→unassigned, scheduled_for effacé, réserve libérée (release
    // dérivé en SQL). cash remis à not_due (annule l'expected d'une programmation).
    case 'deconfirmer':
      return {
        callState: 'to_call',
        cashState: 'not_due',
        deliveryState: 'unassigned',
        clearScheduledFor: true,
      };
    // Lot B — désannuler : ré-ouvre une commande annulée au tout début du tunnel.
    // AUCUN mouvement stock (la réserve a déjà été libérée à l'annulation ; la garde
    // SQL order_state='open' empêche tout release ici).
    case 'desannuler':
      return {
        callState: 'to_call',
        cashState: 'not_due',
        clearCancelReasons: true,
        clearScheduledFor: true,
        deliveryState: 'unassigned',
        orderState: 'open',
      };
  }
}

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
  return getAllowedTransitionActionsForDimensions(legacyStatusToDimensions(status), role);
}

export function getTransitionActionForTarget(
  target: OrderStatus,
  role: TeamRole,
): TransitionAction | null {
  return (
    transitionCatalog.find(
      (item) =>
        item.target === target &&
        item.roles.includes(role) &&
        // Lot B : les actions reverse ne sont jamais sélectionnées par target
        // (sinon « A_APPELER » deviendrait actionnable via les chemins inline).
        item.action !== 'deconfirmer' &&
        item.action !== 'desannuler' &&
        item.action !== 'mark_returned' &&
        // Phase 11.1 : « demarrer_livraison » partage la cible EN_LIVRAISON avec
        // « assigner » → exclue ici pour que la sélection par target (chemins
        // inline status) reste déterministe sur « assigner ».
        item.action !== 'demarrer_livraison',
    )?.action ?? null
  );
}
