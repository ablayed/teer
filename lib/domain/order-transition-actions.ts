import { type OrderStatus, orderStatuses } from '@/lib/domain/order-state-machine';
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
  nextContactAt?: string;
  paymentChannelAtDelivery?: PaymentChannelAtDelivery;
  scheduledFor?: string;
};

export type TransitionDimensionPatch = {
  assignedDriverId?: string;
  attemptCount?: number;
  callState?: CallStateDimension;
  cancelReason?: string;
  cashState?: CashStateDimension;
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
    return [];
  }

  return transitionCatalog
    .filter((item) => item.roles.includes(role))
    .filter((item) => {
      switch (item.action) {
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
          return dimensions.callState === 'validated' && dimensions.deliveryState === 'unassigned';
        case 'assigner':
          return dimensions.callState === 'validated' && dimensions.deliveryState === 'scheduled';
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
    case 'livrer':
      return {
        callState: 'validated',
        cashState: 'collected',
        deliveryState: 'delivered',
        orderState: 'completed',
        paymentChannelAtDelivery: payload.paymentChannelAtDelivery ?? 'ESPECES',
      };
    case 'annuler':
      return {
        cashState: 'not_due',
        deliveryState: 'unassigned',
        orderState: 'cancelled',
        cancelReason: payload.cancelReason ?? 'cancelled',
      };
    case 'refuser':
      return {
        callState: 'validated',
        cashState: 'not_due',
        deliveryState: 'failed',
        orderState: 'cancelled',
        cancelReason: payload.cancelReason ?? 'refused',
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
    transitionCatalog.find((item) => item.target === target && item.roles.includes(role))?.action ??
    null
  );
}
