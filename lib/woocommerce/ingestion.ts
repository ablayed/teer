// R2.4 / commit 6 — pont d'écriture WooCommerce vers le moteur commun.
//
// L'adaptateur ne connaît pas ce module. Toute écriture de commande passe ici, puis par la RPC
// persist_connection_order ; il n'existe pas de chemin WooCommerce concurrent vers les tables métier.
import type {
  PersistableCanonicalOrder,
  ResolvedConnectionContext,
} from '@/lib/ingestion/canonical';
import type { Database, Json } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

export type PersistWooCommerceOrderResult =
  | { readonly ok: true; readonly orderId: string }
  | { readonly ok: false; readonly errorCode: 'order_persist_failed' };

function rpcOrder(order: PersistableCanonicalOrder): Json {
  return {
    order_number: order.data.orderNumber,
    total_amount: order.data.totalAmount.toString(),
    currency: order.data.currency ?? 'XOF',
    financial_status: order.data.financialStatus ?? null,
    fulfillment_status: order.data.fulfillmentStatus ?? null,
    created_at: order.data.createdAt,
    items_summary: order.data.lines.map((line) => ({
      title: line.title,
      sku: line.sku,
      quantity: line.quantity,
      price: line.unitAmount,
      product_id: line.productId,
    })),
    shipping_address: order.data.shippingAddress,
  };
}

function rpcCustomer(order: PersistableCanonicalOrder): Json {
  return {
    external_id: order.data.customer.externalId ?? null,
    full_name: order.data.customer.fullName,
    phone: order.data.customer.phone,
    address: order.data.customer.address,
  };
}

function rpcLines(order: PersistableCanonicalOrder): Json {
  return order.data.lines.map((line) => ({
    product_id: line.productId,
    raw_title: line.title,
    raw_sku: line.sku,
    qty: line.quantity,
    match_status: 'unresolved',
  }));
}

export async function persistWooCommerceCanonicalOrder({
  supabase,
  context,
  topic,
  deliveryId,
  order,
}: {
  readonly supabase: AdminClient;
  readonly context: ResolvedConnectionContext;
  readonly topic: 'order.created' | 'order.updated';
  readonly deliveryId: string | null;
  readonly order: PersistableCanonicalOrder;
}): Promise<PersistWooCommerceOrderResult> {
  const { data, error } = await supabase.rpc('persist_connection_order', {
    p_store_connection_id: context.storeConnectionId,
    p_merchant_account_id: context.merchantAccountId,
    p_shop_id: context.shopId,
    p_platform: 'woocommerce',
    p_topic: topic,
    // Le type généré de la fonction est non nullable alors que SQL normalise '' en NULL via
    // nullif(btrim(...), ''). Cela conserve l'absence de delivery_id pour la synchronisation.
    p_delivery_id: deliveryId ?? '',
    p_resource_external_id: order.externalOrderId,
    p_ordering_signal: order.data.updatedAt ?? order.data.createdAt ?? order.data.eventAt,
    p_order: rpcOrder(order),
    p_customer: rpcCustomer(order),
    p_lines: rpcLines(order),
  });

  if (error || !data) {
    return { ok: false, errorCode: 'order_persist_failed' };
  }
  return { ok: true, orderId: String(data) };
}
