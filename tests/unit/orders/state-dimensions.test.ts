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
    ).toEqual(['demarrer_livraison', 'livrer', 'annuler', 'reprogrammer']);
  });

  it("Refuser → Reprogrammer : reprogrammer légal uniquement depuis En cours de livraison (assigned/out_for_delivery), refuser n'y est plus légal, annuler inchangé", () => {
    const enLivraisonAssigned = legacyStatusToDimensions('EN_LIVRAISON');
    const enLivraisonOutForDelivery: OrderDimensions = {
      ...enLivraisonAssigned,
      deliveryState: 'out_for_delivery',
    };

    for (const dims of [enLivraisonAssigned, enLivraisonOutForDelivery]) {
      for (const role of ['owner', 'manager'] as const) {
        const actions = getAllowedTransitionActionsForDimensions(dims, role);
        expect(actions).toContain('reprogrammer');
        expect(actions).toContain('annuler');
        expect(actions).not.toContain('refuser');
      }
      // agent n'a jamais accès à reprogrammer (RBAC aligné sur refuser qu'elle remplace).
      expect(getAllowedTransitionActionsForDimensions(dims, 'agent')).not.toContain('reprogrammer');
    }

    // reprogrammer illégal partout ailleurs — avant dispatch, après livraison, terminal.
    for (const status of orderStatuses) {
      if (status === 'EN_LIVRAISON') {
        continue;
      }
      const dims = legacyStatusToDimensions(status);
      for (const role of ['owner', 'manager', 'agent'] as const) {
        expect(getAllowedTransitionActionsForDimensions(dims, role)).not.toContain('reprogrammer');
      }
    }

    // refuser reste légal avant dispatch (trou préexistant Lot 3 sur "scheduled" hors
    // scope de ce lot, non touché).
    expect(
      getAllowedTransitionActionsForDimensions(legacyStatusToDimensions('A_APPELER'), 'owner'),
    ).toContain('refuser');
    expect(
      getAllowedTransitionActionsForDimensions(legacyStatusToDimensions('PROGRAMMEE'), 'owner'),
    ).toContain('refuser');
  });

  it('reprogrammer patch : ramène En cours de livraison à Programmée avec la nouvelle date (dimensions), orderState reste open', () => {
    const enLivraison = legacyStatusToDimensions('EN_LIVRAISON');
    const scheduledFor = '2099-06-01T09:00:00.000Z';
    const reprogrammed = applyPatch(
      enLivraison,
      buildTransitionDimensionPatch('reprogrammer', enLivraison, { scheduledFor }),
    );

    expect(reprogrammed.codStatus).toBe('PROGRAMMEE');
    expect(reprogrammed.deliveryState).toBe('scheduled');
    expect(reprogrammed.orderState).toBe('open');
    expect(reprogrammed.scheduledFor).toBe(scheduledFor);
  });

  it('le patch reprogrammer vide le livreur (clearAssignedDriver) — même mécanisme que désannuler, cf. migration 0106', () => {
    const scheduledFor = '2099-06-01T09:00:00.000Z';
    const patch = buildTransitionDimensionPatch(
      'reprogrammer',
      legacyStatusToDimensions('EN_LIVRAISON'),
      { scheduledFor },
    );

    expect(patch).toEqual({
      callState: 'validated',
      cashState: 'expected',
      clearAssignedDriver: true,
      deliveryState: 'scheduled',
      scheduledFor,
    });
  });

  it('Lot 3 - deconfirmer (affiché "Déprogrammer") reste légal sur PROGRAMMEE pour les 3 rôles', () => {
    const programmed = legacyStatusToDimensions('PROGRAMMEE');
    for (const role of ['owner', 'manager', 'agent'] as const) {
      expect(getAllowedTransitionActionsForDimensions(programmed, role)).toContain('deconfirmer');
    }
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
