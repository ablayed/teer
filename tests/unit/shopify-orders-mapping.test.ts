import {
  type ExistingCustomerForMerge,
  type ShopifyOrderNode,
  buildCustomerMergePatch,
  buildShopifyLineItemAttributes,
  buildShopifyOrderAttributes,
  buildShopifyOrderUpdate,
  extractShopifyId,
  isStaleShopifyUpdate,
  mapShopifyCustomer,
  mapShopifyOrder,
  mergeGids,
  shouldResyncShopifyOrderCart,
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

describe('buildShopifyOrderAttributes (note + customAttributes commande)', () => {
  it('retourne null quand ni note ni customAttributes ne sont presents', () => {
    expect(buildShopifyOrderAttributes(makeOrder())).toBeNull();
  });

  it('retourne null quand note est une chaine vide et customAttributes un tableau vide', () => {
    expect(buildShopifyOrderAttributes(makeOrder({ note: '', customAttributes: [] }))).toBeNull();
  });

  it('capture la note seule', () => {
    expect(buildShopifyOrderAttributes(makeOrder({ note: 'Livrer avant midi' }))).toEqual({
      note: 'Livrer avant midi',
      attributes: [],
    });
  });

  it('capture les customAttributes de commande, brut, sans interpretation', () => {
    expect(
      buildShopifyOrderAttributes(
        makeOrder({
          note: null,
          customAttributes: [{ key: 'disponibilite_livraison', value: 'Apres 18h' }],
        }),
      ),
    ).toEqual({
      note: null,
      attributes: [{ key: 'disponibilite_livraison', value: 'Apres 18h' }],
    });
  });

  it('ignore un attribut sans cle', () => {
    expect(
      buildShopifyOrderAttributes(makeOrder({ customAttributes: [{ key: '', value: 'x' }] })),
    ).toBeNull();
  });
});

describe('buildShopifyLineItemAttributes (customAttributes par ligne)', () => {
  it('retourne null quand aucune ligne n_a d_attribut', () => {
    expect(buildShopifyLineItemAttributes(makeOrder())).toBeNull();
  });

  it('capture les customAttributes par ligne, alignes sur items_summary', () => {
    const order = makeOrder({
      lineItems: {
        edges: [
          {
            node: {
              title: 'Sac',
              sku: 'SAC-001',
              quantity: 2,
              originalUnitPriceSet: { shopMoney: { amount: '5000.25' } },
              variant: { id: 'gid://shopify/ProductVariant/444' },
              product: { id: 'gid://shopify/Product/333' },
              customAttributes: [{ key: 'couleur', value: 'Rouge' }],
            },
          },
        ],
      },
    });

    expect(buildShopifyLineItemAttributes(order)).toEqual([
      { title: 'Sac', attributes: [{ key: 'couleur', value: 'Rouge' }] },
    ]);
  });
});

describe('mapShopifyOrder — attributs personnalises', () => {
  it('pose shopify_order_attributes/shopify_line_item_attributes a null en absence d_attributs', () => {
    const order = mapShopifyOrder(makeOrder(), {
      merchantAccountId: 'merchant_123',
      shopId: 'shop_123',
      customerId: null,
    });

    expect(order.shopify_order_attributes).toBeNull();
    expect(order.shopify_line_item_attributes).toBeNull();
  });

  it('capture note + customAttributes commande dans shopify_order_attributes', () => {
    const order = mapShopifyOrder(
      makeOrder({
        note: 'Appeler avant de venir',
        customAttributes: [{ key: 'source_app', value: 'FormBuilder' }],
      }),
      { merchantAccountId: 'merchant_123', shopId: 'shop_123', customerId: null },
    );

    expect(order.shopify_order_attributes).toEqual({
      note: 'Appeler avant de venir',
      attributes: [{ key: 'source_app', value: 'FormBuilder' }],
    });
  });
});

describe('buildShopifyOrderUpdate', () => {
  it('simule un webhook après édition locale : préserve le panier et met à jour le reste', () => {
    const patch = buildShopifyOrderUpdate(
      mapShopifyOrder(
        makeOrder({
          displayFinancialStatus: 'PAID',
          displayFulfillmentStatus: 'FULFILLED',
          shippingAddress: {
            address1: 'Nouvelle adresse',
            address2: null,
            city: 'Thies',
            province: 'Thies',
            country: 'Senegal',
            zip: null,
            phone: '+221771234567',
            name: 'Awa Diop',
          },
        }),
        { merchantAccountId: 'm', shopId: 's', customerId: 'customer-after-webhook' },
      ),
      '2026-07-01T10:00:00Z',
    );
    expect(patch).not.toHaveProperty('items_summary');
    expect(patch).not.toHaveProperty('total_amount');
    expect(patch.financial_status).toBe('PAID');
    expect(patch.fulfillment_status).toBe('FULFILLED');
    expect(patch.customer_id).toBe('customer-after-webhook');
    expect(patch.shipping_address).toMatchObject({ address1: 'Nouvelle adresse', city: 'Thies' });
  });

  it('synchronise le panier sans modification locale', () => {
    const patch = buildShopifyOrderUpdate(
      mapShopifyOrder(makeOrder(), { merchantAccountId: 'm', shopId: 's', customerId: null }),
      null,
    );
    expect(patch.total_amount).toBe(12500.5);
    expect(patch.items_summary).toHaveLength(1);
  });

  it('rafraichit toujours les attributs personnalises, meme apres edition locale du panier (note ajoutee apres coup)', () => {
    const patch = buildShopifyOrderUpdate(
      mapShopifyOrder(makeOrder({ note: 'Note ajoutee apres creation' }), {
        merchantAccountId: 'm',
        shopId: 's',
        customerId: null,
      }),
      '2026-07-01T10:00:00Z',
    );

    expect(patch.shopify_order_attributes).toEqual({
      note: 'Note ajoutee apres creation',
      attributes: [],
    });
  });
});

describe('shouldResyncShopifyOrderCart', () => {
  it('autorise le recalcul uniquement avant assignation et encaissement', () => {
    expect(
      shouldResyncShopifyOrderCart({
        cart_locally_modified_at: null,
        delivery_state: 'unassigned',
        cash_state: 'not_due',
      }),
    ).toBe(true);
  });

  it('conserve order_line pour une commande assignee', () => {
    expect(
      shouldResyncShopifyOrderCart({
        cart_locally_modified_at: null,
        delivery_state: 'assigned',
        cash_state: 'expected',
      }),
    ).toBe(false);
  });

  it('respecte la protection apres edition locale', () => {
    expect(
      shouldResyncShopifyOrderCart({
        cart_locally_modified_at: '2026-07-21T10:00:00Z',
        delivery_state: 'unassigned',
        cash_state: 'not_due',
      }),
    ).toBe(false);
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
    });

    expect(patch.full_name).toBe('Client Manuel');
    expect(patch.shopify_customer_gids).toEqual(['999']);
    expect(patch.shopify_customer_id).toBe('999');
  });
});
