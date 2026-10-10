import { compareOrderUpdate, isStaleOrderUpdate } from '@/lib/ingestion/order-normalization';
import { canRepairShopifyOrderLines } from '@/lib/shopify/orders-sync';
import { describe, expect, it } from 'vitest';

describe('compareOrderUpdate — situer une charge par rapport à celle déjà appliquée', () => {
  it('sépare « plus ancienne » de « identique », que la garde de date confond', () => {
    const stored = '2026-08-01T10:00:00Z';
    expect(compareOrderUpdate('2026-08-01T09:59:59Z', stored)).toBe('older');
    expect(compareOrderUpdate('2026-08-01T10:00:00Z', stored)).toBe('same');
    expect(compareOrderUpdate('2026-08-01T10:00:01Z', stored)).toBe('newer');
    // Les deux sont « périmées » pour la garde historique.
    expect(isStaleOrderUpdate('2026-08-01T09:59:59Z', stored)).toBe(true);
    expect(isStaleOrderUpdate('2026-08-01T10:00:00Z', stored)).toBe(true);
  });

  it('compare des instants, pas des chaînes', () => {
    expect(compareOrderUpdate('2026-08-01T12:00:00+02:00', '2026-08-01T10:00:00Z')).toBe('same');
  });

  it('ne tranche pas sans les deux dates, ni sur une date illisible', () => {
    expect(compareOrderUpdate(null, '2026-08-01T10:00:00Z')).toBe('unknown');
    expect(compareOrderUpdate('2026-08-01T10:00:00Z', undefined)).toBe('unknown');
    expect(compareOrderUpdate('pas une date', '2026-08-01T10:00:00Z')).toBe('unknown');
  });
});

describe('canRepairShopifyOrderLines — état où l import peut écrire des lignes manquantes', () => {
  const fresh = {
    call_state: 'to_call',
    cart_locally_modified_at: null,
    cash_state: 'not_due',
    delivery_state: 'unassigned',
    order_state: 'open',
  };

  it('accepte une commande ouverte, non confirmée, non assignée', () => {
    expect(canRepairShopifyOrderLines(fresh)).toBe(true);
    expect(canRepairShopifyOrderLines({ ...fresh, call_state: 'callback' })).toBe(true);
  });

  it('refuse dès qu une transition a pu toucher au stock, ou que le panier a été modifié', () => {
    for (const patch of [
      { call_state: 'validated' },
      { order_state: 'cancelled' },
      { delivery_state: 'scheduled' },
      { delivery_state: 'assigned' },
      { cash_state: 'expected' },
      { cart_locally_modified_at: '2026-08-02T00:00:00Z' },
    ]) {
      expect(canRepairShopifyOrderLines({ ...fresh, ...patch }), JSON.stringify(patch)).toBe(false);
    }
  });
});
