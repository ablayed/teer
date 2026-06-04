import type {
  DeliveryStateDimension,
  TransitionAction,
} from '@/lib/domain/order-transition-actions';
import { type StockMovementType, getMovementTypeForAction } from '@/lib/stock/movements';
import { describe, expect, it } from 'vitest';

describe('getMovementTypeForAction', () => {
  const cases: Array<[TransitionAction, DeliveryStateDimension, StockMovementType | null]> = [
    ['journaliser_appel', 'unassigned', null],
    ['confirmer', 'unassigned', 'reserve'],
    ['confirmer', 'scheduled', 'reserve'],
    ['programmer', 'unassigned', null],
    ['assigner', 'scheduled', 'dispatch'],
    ['livrer', 'assigned', 'sold'],
    ['livrer', 'out_for_delivery', 'sold'],
    // annuler before dispatch → release reservation
    ['annuler', 'unassigned', 'release'],
    ['annuler', 'scheduled', 'release'],
    // annuler after dispatch → no auto-restore (courier_return separately)
    ['annuler', 'assigned', null],
    ['annuler', 'out_for_delivery', null],
    // refuser mirrors annuler
    ['refuser', 'unassigned', 'release'],
    ['refuser', 'scheduled', 'release'],
    ['refuser', 'assigned', null],
    ['refuser', 'out_for_delivery', null],
  ];

  it.each(cases)('action=%s deliveryState=%s → %s', (action, deliveryState, expected) => {
    expect(getMovementTypeForAction(action, deliveryState)).toBe(expected);
  });
});
