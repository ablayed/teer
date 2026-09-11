import type {
  PersistableCanonicalOrder,
  ResolvedConnectionContext,
} from '@/lib/ingestion/canonical';
import { persistWooCommerceCanonicalOrder } from '@/lib/woocommerce/ingestion';
import { describe, expect, it, vi } from 'vitest';

function order(): PersistableCanonicalOrder {
  return {
    kind: 'order',
    externalOrderId: '42',
    raw: undefined,
    data: {
      payloadVersion: 'woocommerce-rest-v3',
      eventAt: '2026-09-01T10:05:00.000Z',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:05:00.000Z',
      orderNumber: '42',
      totalAmount: 1250,
      currency: 'XOF',
      financialStatus: 'processing',
      fulfillmentStatus: 'unfulfilled',
      customer: {
        externalId: '7',
        fullName: 'Awa Ndiaye',
        phone: '770000000',
        address: null,
      },
      shippingAddress: { address1: 'Rue 1', city: 'Dakar' },
      lines: [
        {
          title: 'Produit',
          sku: 'SKU-1',
          quantity: 1,
          unitAmount: 1250,
          productId: null,
        },
      ],
    },
  };
}

const context = {
  storeConnectionId: 'connection-1',
  merchantAccountId: 'merchant-1',
  shopId: 'shop-1',
  platform: 'woocommerce',
  platformAppId: null,
} as ResolvedConnectionContext;

describe('pont d’ingestion WooCommerce', () => {
  it('appelle uniquement la RPC générique avec le contexte résolu', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'order-1', error: null });
    const from = vi.fn(() => {
      throw new Error('aucune écriture directe autorisée');
    });
    const supabase = { rpc, from } as never;

    const result = await persistWooCommerceCanonicalOrder({
      supabase,
      context,
      topic: 'order.updated',
      deliveryId: 'delivery-1',
      order: order(),
    });

    expect(result).toEqual({ ok: true, orderId: 'order-1' });
    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('persist_connection_order', {
      p_store_connection_id: 'connection-1',
      p_merchant_account_id: 'merchant-1',
      p_shop_id: 'shop-1',
      p_platform: 'woocommerce',
      p_topic: 'order.updated',
      p_delivery_id: 'delivery-1',
      p_resource_external_id: '42',
      p_ordering_signal: '2026-09-01T10:05:00.000Z',
      p_order: expect.objectContaining({ total_amount: '1250' }),
      p_customer: expect.objectContaining({ external_id: '7' }),
      p_lines: expect.arrayContaining([expect.objectContaining({ raw_sku: 'SKU-1' })]),
    });
  });

  it('représente l’absence de delivery_id par la valeur SQL normalisée', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'order-1', error: null });
    const supabase = { rpc } as never;

    await persistWooCommerceCanonicalOrder({
      supabase,
      context,
      topic: 'order.updated',
      deliveryId: null,
      order: order(),
    });

    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_delivery_id: '' });
  });
});
