import type {
  DeliveryStateDimension,
  TransitionAction,
} from '@/lib/domain/order-transition-actions';

export type StockMovementType =
  | 'courier_return'
  | 'dispatch'
  | 'manual_adjustment'
  | 'purchase_in'
  | 'release'
  | 'reserve'
  | 'sold';

// Kept for display / allowedActions inference in TS; the authoritative
// derivation now lives in the SQL transition_order function (0029).
export function getMovementTypeForAction(
  action: TransitionAction,
  currentDeliveryState: DeliveryStateDimension,
): StockMovementType | null {
  switch (action) {
    case 'confirmer':
      return 'reserve';
    case 'assigner':
      return 'dispatch';
    case 'livrer':
      return 'sold';
    case 'annuler':
    case 'refuser':
      return currentDeliveryState === 'unassigned' || currentDeliveryState === 'scheduled'
        ? 'release'
        : null;
    default:
      return null;
  }
}
