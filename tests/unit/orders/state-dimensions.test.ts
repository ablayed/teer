import { orderStatuses } from '@/lib/domain/order-state-machine';
import {
  type OrderDimensions,
  type TransitionDimensionPatch,
  buildTransitionDimensionPatch,
  deriveLegacyStatusFromDimensions,
  getAllowedTransitionActionsForDimensions,
  legacyStatusToDimensions,
  resolveOrderDimensions,
} from '@/lib/domain/order-transition-actions';
import { describe, expect, it } from 'vitest';

function applyPatch(dimensions: OrderDimensions, patch: TransitionDimensionPatch): OrderDimensions {
  return resolveOrderDimensions({
    assigned_driver_id: patch.assignedDriverId ?? dimensions.assignedDriverId,
    attempt_count: patch.attemptCount ?? dimensions.attemptCount,
    call_state: patch.callState ?? dimensions.callState,
    cancel_reason: patch.cancelReason ?? dimensions.cancelReason,
    cash_state: patch.cashState ?? dimensions.cashState,
    cod_status: dimensions.codStatus,
    delivery_state: patch.deliveryState ?? dimensions.deliveryState,
    next_contact_at: patch.nextContactAt ?? dimensions.nextContactAt,
    order_state: patch.orderState ?? dimensions.orderState,
    scheduled_for: patch.scheduledFor ?? dimensions.scheduledFor,
  });
}

describe('order state dimensions', () => {
  it('round-trips every legacy COD status through the dimension model', () => {
    for (const status of orderStatuses) {
      const dimensions = legacyStatusToDimensions(status);

      expect(deriveLegacyStatusFromDimensions(dimensions)).toBe(status);
      expect(resolveOrderDimensions({ cod_status: status })).toMatchObject({
        callState: dimensions.callState,
        cashState: dimensions.cashState,
        deliveryState: dimensions.deliveryState,
        orderState: dimensions.orderState,
      });
    }
  });

  it('derives REFUSEE from a failed delivery even when order_state is cancelled', () => {
    expect(
      deriveLegacyStatusFromDimensions({
        callState: 'validated',
        cashState: 'not_due',
        deliveryState: 'failed',
        orderState: 'cancelled',
      }),
    ).toBe('REFUSEE');
  });

  it('preserves scheduled_for when assignment does not provide a new date', () => {
    const scheduledFor = '2099-05-01T10:30:00.000Z';
    const confirmed = legacyStatusToDimensions('CONFIRMEE');
    const programmed = applyPatch(
      confirmed,
      buildTransitionDimensionPatch('programmer', confirmed, { scheduledFor }),
    );
    const assigned = applyPatch(programmed, buildTransitionDimensionPatch('assigner', programmed));

    expect(programmed.scheduledFor).toBe(scheduledFor);
    expect(assigned.scheduledFor).toBe(scheduledFor);
    expect(assigned.deliveryState).toBe('assigned');
    expect(assigned.codStatus).toBe('EN_LIVRAISON');
  });

  it('computes allowed actions from dimensions instead of legacy labels alone', () => {
    expect(
      getAllowedTransitionActionsForDimensions(legacyStatusToDimensions('A_APPELER'), 'agent'),
    ).toEqual(['journaliser_appel', 'confirmer', 'programmer']);
    expect(
      getAllowedTransitionActionsForDimensions(legacyStatusToDimensions('PROGRAMMEE'), 'agent'),
    ).toEqual(['assigner', 'deconfirmer']);
    expect(
      getAllowedTransitionActionsForDimensions(legacyStatusToDimensions('EN_LIVRAISON'), 'owner'),
    ).toEqual(['livrer', 'annuler', 'refuser']);
  });

  it('returns a delivered order with cash reset to not_due', () => {
    const delivered = legacyStatusToDimensions('LIVREE');
    const returned = applyPatch(
      delivered,
      buildTransitionDimensionPatch('mark_returned', delivered),
    );

    expect(returned.orderState).toBe('returned');
    expect(returned.deliveryState).toBe('returned');
    expect(returned.cashState).toBe('not_due');
    expect(returned.codStatus).toBe('REFUSEE');
    expect(getAllowedTransitionActionsForDimensions(delivered, 'owner')).toEqual(['mark_returned']);
    expect(getAllowedTransitionActionsForDimensions(returned, 'owner')).toEqual([]);
  });
});
