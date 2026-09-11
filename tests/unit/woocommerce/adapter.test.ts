import {
  WOO_COMMERCE_ORDER_STATUSES,
  mapWooCommerceOrder,
  mapWooCommerceStatus,
} from '@/lib/woocommerce/adapter';
import { describe, expect, it } from 'vitest';

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    number: 'WC-42',
    status: 'processing',
    date_created_gmt: '2026-09-01T10:00:00',
    date_modified_gmt: '2026-09-01T10:05:00',
    total: '1250.00',
    currency: 'xof',
    customer_id: 7,
    billing: {
      first_name: 'Awa',
      last_name: 'Ndiaye',
      phone: '770000000',
      address_1: 'Rue 1',
      city: 'Dakar',
      state: 'Dakar',
      postcode: '10000',
      country: 'SN',
    },
    shipping: {
      address_1: 'Rue 2',
      city: 'Dakar',
      state: 'Dakar',
      country: 'SN',
    },
    line_items: [
      { name: 'Produit', sku: 'SKU-1', quantity: 2, total: '1000.00' },
      { name: 'Livraison', sku: null, quantity: 1, total: '250.00' },
    ],
    ...overrides,
  };
}

describe('adaptateur pur WooCommerce', () => {
  it('normalise dates GMT, identité, client, adresse, montants et lignes', () => {
    const result = mapWooCommerceOrder(order());

    expect(result).toMatchObject({
      kind: 'order',
      externalOrderId: '42',
      data: {
        eventAt: '2026-09-01T10:05:00.000Z',
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:05:00.000Z',
        totalAmount: 1250,
        currency: 'XOF',
        financialStatus: 'processing',
        fulfillmentStatus: 'processing',
        customer: {
          externalId: '7',
          fullName: 'Awa Ndiaye',
          phone: '770000000',
          address: { address1: 'Rue 1', city: 'Dakar', province: 'Dakar' },
        },
        shippingAddress: { address1: 'Rue 2', city: 'Dakar' },
        lines: [
          { title: 'Produit', sku: 'SKU-1', quantity: 2, unitAmount: 500 },
          { title: 'Livraison', sku: null, quantity: 1, unitAmount: 250 },
        ],
      },
    });
  });

  it('représente un client invité sans inventer de référence externe', () => {
    const result = mapWooCommerceOrder(order({ customer_id: 0 }));
    expect(result?.data.customer.externalId).toBeNull();
  });

  it('refuse un statut, une date, un montant ou une ligne hors contrat', () => {
    expect(mapWooCommerceOrder(order({ status: 'trash' }))).toBeNull();
    expect(mapWooCommerceOrder(order({ date_modified_gmt: 'not-a-date' }))).toBeNull();
    expect(mapWooCommerceOrder(order({ total: 'not-a-number' }))).toBeNull();
    expect(mapWooCommerceOrder(order({ line_items: [] }))).toBeNull();
  });

  it('épingle les huit statuts WooCommerce du préflight', () => {
    expect(WOO_COMMERCE_ORDER_STATUSES).toHaveLength(8);
    for (const status of WOO_COMMERCE_ORDER_STATUSES) {
      expect(mapWooCommerceStatus(status)).not.toBeNull();
    }
    expect(mapWooCommerceStatus('unknown')).toBeNull();
  });
});
