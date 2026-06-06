import {
  type ExistingCustomerForMerge,
  type ShopifyOrderNode,
  buildCustomerMergePatch,
  extractShopifyId,
  isStaleShopifyUpdate,
  mapShopifyCustomer,
  mapShopifyOrder,
  mergeGids,
} from '@/lib/shopify/orders-sync';
import { describe, expect, it } from 'vitest';

function makeOrder(overrides: Partial<ShopifyOrderNode> = {}): ShopifyOrderNode {
  return {
    id: 'gid://shopify/Order/123456789',
    name: '#1001',
    createdAt: '2026-05-30T12:00:00Z',
    displayFinancialStatus: 'PENDING',
    displayFulfillmentStatus: 'UNFULFILLED',
    currentTotalPriceSet: {
      shopMoney: {
        amount: '12500.50',
        currencyCode: 'XOF',
      },
    },
    customer: {
      id: 'gid://shopify/Customer/987654321',
      displayName: 'Awa Diop',
      phone: '+221771234567',
      email: 'awa@example.com',
    },
    shippingAddress: {
      address1: 'Rue 10',
      address2: null,
      city: 'Dakar',
      province: 'Dakar',
      country: 'Senegal',
      zip: '12500',
      phone: '+221771234567',
      name: 'Awa Diop',
    },
    lineItems: {
      edges: [
        {
          node: {
            title: 'Sac',
            sku: 'SAC-001',
            quantity: 2,
            originalUnitPriceSet: {
              shopMoney: { amount: '5000.25' },
            },
            variant: {
              id: 'gid://shopify/ProductVariant/444',
            },
            product: {
              id: 'gid://shopify/Product/333',
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

describe('extractShopifyId', () => {
  it('extracts the numeric ID from a Shopify GID', () => {
    expect(extractShopifyId('gid://shopify/Order/123456')).toBe('123456');
  });
});

describe('mapShopifyCustomer', () => {
  it('maps a Shopify customer from an order node (enrichi Phase 7b)', () => {
    expect(mapShopifyCustomer(makeOrder(), 'merchant_123')).toEqual({
      merchant_account_id: 'merchant_123',
      source: 'shopify',
      shopify_customer_id: '987654321',
      shopify_customer_gids: ['987654321'],
      full_name: 'Awa Diop',
      first_name: null,
      last_name: null,
      phone: '+221771234567',
      phone_e164: '+221771234567',
      email: 'awa@example.com',
      accepts_marketing: null,
      tags: null,
      address: {
        raw: 'Rue 10, Dakar, Dakar',
        landmark: null,
        quartier: null,
        city: 'Dakar',
        region: 'Dakar',
        notes: null,
      },
      shipping_address: {
        address1: 'Rue 10',
        address2: null,
        city: 'Dakar',
        province: 'Dakar',
        country: 'Senegal',
        zip: '12500',
      },
      shopify_orders_count: null,
      shopify_amount_spent_minor: null,
      first_seen_at: null,
    });
  });

  it('enrichit nom/numberOfOrders/amountSpent/tags/consentement/adresse par defaut', () => {
    const enriched = mapShopifyCustomer(
      makeOrder({
        customer: {
          id: 'gid://shopify/Customer/555',
          displayName: 'Fatou Sow',
          firstName: 'Fatou',
          lastName: 'Sow',
          phone: '771112233',
          email: 'fatou@example.com',
          numberOfOrders: '4',
          amountSpent: { amount: '125000.00', currencyCode: 'XOF' },
          tags: ['VIP', 'fidele'],
          emailMarketingConsent: { marketingState: 'SUBSCRIBED' },
          createdAt: '2025-01-15T08:00:00Z',
          defaultAddress: {
            address1: 'Cite Keur Gorgui',
            address2: 'Pres de la mosquee',
            city: 'Dakar',
            province: 'Dakar',
            country: 'Senegal',
            zip: null,
            phone: null,
            name: 'Fatou Sow',
          },
        },
      }),
      'merchant_123',
    );

    expect(enriched).toMatchObject({
      shopify_customer_id: '555',
      shopify_customer_gids: ['555'],
      first_name: 'Fatou',
      last_name: 'Sow',
      phone_e164: '+221771112233',
      accepts_marketing: true,
      tags: ['VIP', 'fidele'],
      shopify_orders_count: 4,
      shopify_amount_spent_minor: 125000,
      first_seen_at: '2025-01-15T08:00:00Z',
      address: {
        raw: 'Cite Keur Gorgui, Pres de la mosquee, Dakar, Dakar',
        landmark: 'Pres de la mosquee',
        quartier: null,
        city: 'Dakar',
        region: 'Dakar',
        notes: null,
      },
    });
  });

  it('returns null when the Shopify customer is missing', () => {
    expect(mapShopifyCustomer(makeOrder({ customer: null }), 'merchant_123')).toBeNull();
  });
});

describe('mapShopifyOrder', () => {
  it('maps order totals, currency and statuses', () => {
    expect(
      mapShopifyOrder(makeOrder(), {
        merchantAccountId: 'merchant_123',
        shopId: 'shop_123',
        customerId: 'customer_123',
      }),
    ).toMatchObject({
      merchant_account_id: 'merchant_123',
      shop_id: 'shop_123',
      customer_id: 'customer_123',
      shopify_order_id: '123456789',
      order_number: '#1001',
      total_amount: 12500.5,
      currency: 'XOF',
      financial_status: 'PENDING',
      fulfillment_status: 'UNFULFILLED',
      created_at_shopify: '2026-05-30T12:00:00Z',
    });
  });

  it('preserves the Shopify currency code', () => {
    const order = mapShopifyOrder(
      makeOrder({
        currentTotalPriceSet: {
          shopMoney: {
            amount: '99.95',
            currencyCode: 'USD',
          },
        },
      }),
      {
        merchantAccountId: 'merchant_123',
        shopId: 'shop_123',
        customerId: null,
      },
    );

    expect(order.currency).toBe('USD');
  });

  it('maps line items into items summary while preserving Shopify identifiers', () => {
    const order = mapShopifyOrder(makeOrder(), {
      merchantAccountId: 'merchant_123',
      shopId: 'shop_123',
      customerId: null,
    });

    expect(order.items_summary).toEqual([
      {
        title: 'Sac',
        sku: 'SAC-001',
        quantity: 2,
        price: 5000.25,
        shopify_variant_id: '444',
        shopify_product_id: '333',
      },
    ]);
  });

  it('handles a missing shipping address', () => {
    const order = mapShopifyOrder(makeOrder({ shippingAddress: null }), {
      merchantAccountId: 'merchant_123',
      shopId: 'shop_123',
      customerId: null,
    });

    expect(order.shipping_address).toBeNull();
  });

  it('pose les 4 dimensions aux defauts a l_insert (Shopify n_ecrase pas l_etat operationnel)', () => {
    const order = mapShopifyOrder(makeOrder(), {
      merchantAccountId: 'merchant_123',
      shopId: 'shop_123',
      customerId: null,
    });

    expect(order.order_state).toBe('open');
    expect(order.call_state).toBe('to_call');
    expect(order.delivery_state).toBe('unassigned');
    expect(order.cash_state).toBe('not_due');
  });

  it('ecrit les colonnes miroir de canal shopify_* (distinctes des dimensions)', () => {
    const order = mapShopifyOrder(
      makeOrder({
        updatedAt: '2026-06-01T10:00:00Z',
        cancelledAt: '2026-06-01T11:00:00Z',
        displayFinancialStatus: 'REFUNDED',
        displayFulfillmentStatus: 'FULFILLED',
      }),
      { merchantAccountId: 'm', shopId: 's', customerId: null },
    );

    expect(order.shopify_financial_status).toBe('REFUNDED');
    expect(order.shopify_fulfillment_status).toBe('FULFILLED');
    expect(order.shopify_cancelled_at).toBe('2026-06-01T11:00:00Z');
    expect(order.shopify_updated_at).toBe('2026-06-01T10:00:00Z');
  });
});

describe('isStaleShopifyUpdate (garde hors-ordre)', () => {
  it('webhook plus ancien que le stocke → perime (ignore)', () => {
    expect(isStaleShopifyUpdate('2026-06-01T10:00:00Z', '2026-06-01T12:00:00Z')).toBe(true);
  });

  it('webhook identique au stocke → perime (ignore)', () => {
    expect(isStaleShopifyUpdate('2026-06-01T12:00:00Z', '2026-06-01T12:00:00Z')).toBe(true);
  });

  it('webhook plus recent → applique', () => {
    expect(isStaleShopifyUpdate('2026-06-01T13:00:00Z', '2026-06-01T12:00:00Z')).toBe(false);
  });

  it('stocke absent (premiere fois) → applique', () => {
    expect(isStaleShopifyUpdate('2026-06-01T13:00:00Z', null)).toBe(false);
  });
});

describe('mergeGids (union des GID Shopify)', () => {
  it('ajoute le GID entrant absent', () => {
    expect(mergeGids(['111'], '222')).toEqual(['111', '222']);
  });

  it('ne duplique pas un GID déjà présent', () => {
    expect(mergeGids(['111', '222'], '222')).toEqual(['111', '222']);
  });

  it('part d_un tableau vide ou invalide', () => {
    expect(mergeGids([], '333')).toEqual(['333']);
    expect(mergeGids(null as never, '333')).toEqual(['333']);
  });

  it('ignore un GID entrant nul', () => {
    expect(mergeGids(['111'], null)).toEqual(['111']);
  });
});

describe('buildCustomerMergePatch (fusion non destructive)', () => {
  function makeExisting(
    overrides: Partial<ExistingCustomerForMerge> = {},
  ): ExistingCustomerForMerge {
    return {
      id: 'cust-1',
      full_name: 'Awa Diop',
      first_name: null,
      last_name: null,
      email: null,
      phone: '+221771234567',
      phone_e164: '+221771234567',
      address: null,
      shipping_address: null,
      tags: null,
      accepts_marketing: null,
      shopify_customer_gids: ['111'],
      shopify_customer_id: '111',
      shopify_orders_count: null,
      shopify_amount_spent_minor: null,
      ...overrides,
    };
  }

  it('garde la PII existante non vide et remplit les trous depuis l_entrant', () => {
    const patch = buildCustomerMergePatch(makeExisting(), {
      merchant_account_id: 'm',
      source: 'shopify',
      shopify_customer_id: '222',
      shopify_customer_gids: ['222'],
      full_name: 'Autre Nom',
      first_name: 'Awa',
      last_name: 'Diop',
      phone: '+221770000000',
      phone_e164: '+221770000000',
      email: 'awa@example.com',
      accepts_marketing: true,
      tags: ['VIP'],
      address: { raw: 'Dakar' },
      shipping_address: null,
      shopify_orders_count: 5,
      shopify_amount_spent_minor: 90000,
      first_seen_at: null,
    });

    // existant non vide conservé
    expect(patch.full_name).toBe('Awa Diop');
    expect(patch.phone_e164).toBe('+221771234567');
    // trous remplis depuis l'entrant
    expect(patch.first_name).toBe('Awa');
    expect(patch.email).toBe('awa@example.com');
    expect(patch.accepts_marketing).toBe(true);
    expect(patch.tags).toEqual(['VIP']);
    // compteurs Shopify = derniere valeur connue (entrant prioritaire)
    expect(patch.shopify_orders_count).toBe(5);
    expect(patch.shopify_amount_spent_minor).toBe(90000);
    // union des GID (manuel/legacy + nouvelle boutique)
    expect(patch.shopify_customer_gids).toEqual(['111', '222']);
  });

  it('fusionne un client manuel (sans GID) avec un client Shopify → un seul, GID conservé', () => {
    const manualExisting = makeExisting({
      shopify_customer_gids: [],
      shopify_customer_id: null,
      full_name: 'Client Manuel',
    });
    const patch = buildCustomerMergePatch(manualExisting, {
      merchant_account_id: 'm',
      source: 'shopify',
      shopify_customer_id: '999',
      shopify_customer_gids: ['999'],
      full_name: 'Shopify Name',
      phone: '+221771234567',
      phone_e164: '+221771234567',
      email: null,
    });

    expect(patch.full_name).toBe('Client Manuel');
    expect(patch.shopify_customer_gids).toEqual(['999']);
    expect(patch.shopify_customer_id).toBe('999');
  });
});
