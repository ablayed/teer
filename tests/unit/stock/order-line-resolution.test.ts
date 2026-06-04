import { parseItemsummary } from '@/lib/stock/order-line-resolution';
import { describe, expect, it } from 'vitest';

describe('parseItemsummary', () => {
  it('returns empty array for null / non-array', () => {
    expect(parseItemsummary(null)).toEqual([]);
    expect(parseItemsummary('string' as unknown as null)).toEqual([]);
    expect(parseItemsummary({} as unknown as null)).toEqual([]);
  });

  it('filters items without a title', () => {
    const items = [
      { quantity: 1, price: 1000 },
      { title: '', quantity: 1 },
    ];
    expect(parseItemsummary(items)).toHaveLength(0);
  });

  it('parses a minimal Shopify-style item', () => {
    const items = [{ title: 'Sac cuir', quantity: 2, price: 15000 }];
    const result = parseItemsummary(items);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: 'Sac cuir', quantity: 2, price: 15000 });
  });

  it('parses all optional Shopify identifiers', () => {
    const items = [
      {
        title: 'Produit A',
        sku: 'SKU-A',
        quantity: 3,
        price: 5000,
        shopify_variant_id: 'var_123',
        shopify_product_id: 'prod_456',
      },
    ];
    const result = parseItemsummary(items);
    expect(result[0]).toMatchObject({
      sku: 'SKU-A',
      shopify_variant_id: 'var_123',
      shopify_product_id: 'prod_456',
    });
  });

  it('parses manual order items with product_id', () => {
    const pid = '11111111-1111-1111-1111-111111111111';
    const items = [{ title: 'Produit manuel', quantity: 1, price: 8000, product_id: pid }];
    const result = parseItemsummary(items);
    expect(result[0]?.product_id).toBe(pid);
  });

  it('defaults quantity to 1 when missing or invalid', () => {
    const items = [{ title: 'Item', quantity: -5 }, { title: 'Item2' }];
    const result = parseItemsummary(items);
    expect(result[0]?.quantity).toBe(1);
    expect(result[1]?.quantity).toBe(1);
  });

  it('handles multiple items in order', () => {
    const items = [
      { title: 'A', quantity: 2, price: 1000 },
      { title: 'B', quantity: 3, price: 2000 },
    ];
    const result = parseItemsummary(items);
    expect(result).toHaveLength(2);
    expect(result[0]?.title).toBe('A');
    expect(result[1]?.title).toBe('B');
  });
});
