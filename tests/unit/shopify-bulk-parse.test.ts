import { buildBulkOrdersQuery, parseBulkOrdersJsonl } from '@/lib/shopify/bulk';
import { describe, expect, it } from 'vitest';

describe('buildBulkOrdersQuery', () => {
  it('ajoute un filtre updated_at quand une date est fournie', () => {
    const query = buildBulkOrdersQuery('2026-06-01T00:00:00Z');
    expect(query).toContain("updated_at:>='2026-06-01T00:00:00Z'");
    expect(query).toContain('lineItems');
  });

  it('sans date → pas de filtre query', () => {
    const query = buildBulkOrdersQuery(null);
    expect(query).not.toContain('updated_at');
  });
});

describe('parseBulkOrdersJsonl', () => {
  it('réassemble les enfants (lineItems) via __parentId', () => {
    const jsonl = [
      JSON.stringify({
        __typename: 'Order',
        id: 'gid://shopify/Order/1',
        name: '#1001',
        createdAt: '2026-06-01T09:00:00Z',
        updatedAt: '2026-06-01T10:00:00Z',
        cancelledAt: null,
        displayFinancialStatus: 'PAID',
        displayFulfillmentStatus: 'UNFULFILLED',
        currentTotalPriceSet: { shopMoney: { amount: '15000', currencyCode: 'XOF' } },
        customer: { id: 'gid://shopify/Customer/9', displayName: 'Awa', phone: null },
        shippingAddress: { address1: 'Rue 1', city: 'Dakar' },
      }),
      JSON.stringify({
        __typename: 'LineItem',
        id: 'gid://shopify/LineItem/11',
        __parentId: 'gid://shopify/Order/1',
        title: 'Sac',
        sku: 'SAC-1',
        quantity: 2,
        originalUnitPriceSet: { shopMoney: { amount: '5000' } },
        variant: { id: 'gid://shopify/ProductVariant/44' },
        product: { id: 'gid://shopify/Product/33' },
      }),
      JSON.stringify({
        __typename: 'LineItem',
        id: 'gid://shopify/LineItem/12',
        __parentId: 'gid://shopify/Order/1',
        title: 'Ceinture',
        sku: null,
        quantity: 1,
        originalUnitPriceSet: { shopMoney: { amount: '5000' } },
        variant: null,
        product: null,
      }),
    ].join('\n');

    const orders = parseBulkOrdersJsonl(jsonl);
    expect(orders).toHaveLength(1);
    const order = orders[0];
    expect(order.id).toBe('gid://shopify/Order/1');
    expect(order.name).toBe('#1001');
    expect(order.updatedAt).toBe('2026-06-01T10:00:00Z');
    expect(order.currentTotalPriceSet.shopMoney.amount).toBe('15000');
    expect(order.customer?.displayName).toBe('Awa');
    expect(order.lineItems.edges).toHaveLength(2);
    expect(order.lineItems.edges[0].node.title).toBe('Sac');
    expect(order.lineItems.edges[0].node.quantity).toBe(2);
    expect(order.lineItems.edges[1].node.variant).toBeNull();
  });

  it('ignore les lignes vides et le JSON invalide', () => {
    const jsonl = [
      '',
      '   ',
      'not-json',
      JSON.stringify({ id: 'gid://shopify/Order/2', name: '#2' }),
    ].join('\n');
    const orders = parseBulkOrdersJsonl(jsonl);
    expect(orders).toHaveLength(1);
    expect(orders[0].id).toBe('gid://shopify/Order/2');
    expect(orders[0].lineItems.edges).toHaveLength(0);
  });
});
