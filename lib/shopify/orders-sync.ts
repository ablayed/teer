import { parseItemsummary, resolveAndInsertOrderLines } from '@/lib/stock/order-line-resolution';
import type { Database, Json, TablesInsert, TablesUpdate } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

export const SHOPIFY_ORDERS_QUERY = `
query Orders($cursor: String) {
  orders(first: 50, after: $cursor, sortKey: CREATED_AT, reverse: true) {
    edges {
      cursor
      node {
        id
        name
        createdAt
        updatedAt
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        customer { id displayName phone email }
        shippingAddress { address1 address2 city province country zip phone name }
        lineItems(first: 20) {
          edges {
            node {
              title
              sku
              quantity
              originalUnitPriceSet { shopMoney { amount } }
              variant { id }
              product { id }
            }
          }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
`;

export type ShopifyMoney = {
  amount: string;
  currencyCode?: string;
};

export type ShopifyAddress = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  zip: string | null;
  phone?: string | null;
  name?: string | null;
};

export type ShopifyCustomerNode = {
  id: string;
  displayName: string | null;
  phone: string | null;
  email: string | null;
};

export type ShopifyLineItemNode = {
  title: string;
  sku: string | null;
  quantity: number;
  originalUnitPriceSet: {
    shopMoney: {
      amount: string;
    };
  };
  variant: {
    id: string;
  } | null;
  product: {
    id: string;
  } | null;
};

export type ShopifyOrderNode = {
  id: string;
  name: string;
  createdAt: string | null;
  // Horodatage Shopify du dernier changement + annulation → miroir de canal & garde hors-ordre.
  updatedAt?: string | null;
  cancelledAt?: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  currentTotalPriceSet: {
    shopMoney: ShopifyMoney;
  };
  customer: ShopifyCustomerNode | null;
  shippingAddress: ShopifyAddress | null;
  lineItems: {
    edges: Array<{
      node: ShopifyLineItemNode;
    }>;
  };
};

export type ShopifyOrdersResponse = {
  orders: {
    edges: Array<{
      cursor: string;
      node: ShopifyOrderNode;
    }>;
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
};

export type CustomerUpsert = Omit<TablesInsert<'customer'>, 'created_at' | 'id' | 'updated_at'>;

export type OrderUpsert = Omit<
  TablesInsert<'orders'>,
  'cod_status' | 'created_at' | 'id' | 'updated_at'
>;
type CustomerUpdate = Pick<
  TablesUpdate<'customer'>,
  'full_name' | 'phone' | 'email' | 'shipping_address' | 'updated_at'
>;
type OrderShopifyUpdate = Pick<
  TablesUpdate<'orders'>,
  | 'order_number'
  | 'total_amount'
  | 'currency'
  | 'financial_status'
  | 'fulfillment_status'
  | 'shopify_financial_status'
  | 'shopify_fulfillment_status'
  | 'shopify_cancelled_at'
  | 'shopify_updated_at'
  | 'items_summary'
  | 'shipping_address'
  | 'customer_id'
  | 'created_at_shopify'
  | 'updated_at'
>;

type PersistShopifyOrderInput = {
  merchantAccountId: string;
  orderNode: ShopifyOrderNode;
  shopId: string;
  supabaseServiceClient: SupabaseClient<Database>;
};

type OrderMappingContext = {
  merchantAccountId: string;
  shopId: string;
  customerId: string | null;
};

function parseAmount(amount: string): number {
  const value = Number.parseFloat(amount);
  return Number.isFinite(value) ? value : 0;
}

function mapShippingAddress(address: ShopifyAddress | null): Json | null {
  if (!address) {
    return null;
  }

  return {
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    province: address.province,
    country: address.country,
    zip: address.zip,
  };
}

export function extractShopifyId(gid: string): string {
  return gid.split('/').at(-1) ?? gid;
}

export function mapShopifyCustomer(
  node: ShopifyOrderNode,
  merchantAccountId: string,
): CustomerUpsert | null {
  if (!node.customer) {
    return null;
  }

  return {
    merchant_account_id: merchantAccountId,
    shopify_customer_id: extractShopifyId(node.customer.id),
    full_name: node.customer.displayName ?? node.shippingAddress?.name ?? null,
    phone: node.customer.phone ?? node.shippingAddress?.phone ?? null,
    email: node.customer.email,
    shipping_address: mapShippingAddress(node.shippingAddress),
  };
}

export function mapShopifyOrder(
  node: ShopifyOrderNode,
  { merchantAccountId, shopId, customerId }: OrderMappingContext,
): OrderUpsert {
  const money = node.currentTotalPriceSet.shopMoney;

  return {
    order_state: 'open',
    call_state: 'to_call',
    delivery_state: 'unassigned',
    cash_state: 'not_due',
    merchant_account_id: merchantAccountId,
    shop_id: shopId,
    customer_id: customerId,
    // Store the numeric Shopify ID extracted from the GID for compact unique keys.
    shopify_order_id: extractShopifyId(node.id),
    order_number: node.name,
    total_amount: parseAmount(money.amount),
    currency: money.currencyCode ?? 'XOF',
    financial_status: node.displayFinancialStatus,
    fulfillment_status: node.displayFulfillmentStatus,
    // Colonnes miroir de canal (distinctes des 4 dimensions, jamais l'état opérationnel).
    shopify_financial_status: node.displayFinancialStatus,
    shopify_fulfillment_status: node.displayFulfillmentStatus,
    shopify_cancelled_at: node.cancelledAt ?? null,
    shopify_updated_at: node.updatedAt ?? null,
    items_summary: node.lineItems.edges.map(({ node: lineItem }) => ({
      title: lineItem.title,
      sku: lineItem.sku,
      quantity: lineItem.quantity,
      price: parseAmount(lineItem.originalUnitPriceSet.shopMoney.amount),
      shopify_variant_id: lineItem.variant?.id ? extractShopifyId(lineItem.variant.id) : null,
      shopify_product_id: lineItem.product?.id ? extractShopifyId(lineItem.product.id) : null,
    })),
    shipping_address: mapShippingAddress(node.shippingAddress),
    created_at_shopify: node.createdAt,
  };
}

export async function persistShopifyOrder({
  merchantAccountId,
  orderNode,
  shopId,
  supabaseServiceClient,
}: PersistShopifyOrderInput): Promise<{ ok: boolean; error?: string; skipped?: 'stale' }> {
  try {
    const customerData = mapShopifyCustomer(orderNode, merchantAccountId);
    let customerId: string | null = null;

    if (customerData?.shopify_customer_id) {
      const { data: existingCustomer, error: customerSelectError } = await supabaseServiceClient
        .from('customer')
        .select('id')
        .eq('merchant_account_id', merchantAccountId)
        .eq('shopify_customer_id', customerData.shopify_customer_id)
        .maybeSingle();

      if (customerSelectError) {
        return { ok: false, error: customerSelectError.message };
      }

      if (existingCustomer) {
        const customerUpdate: CustomerUpdate = {
          full_name: customerData.full_name,
          phone: customerData.phone,
          email: customerData.email,
          shipping_address: customerData.shipping_address,
          updated_at: new Date().toISOString(),
        };
        const { error: customerUpdateError } = await supabaseServiceClient
          .from('customer')
          .update(customerUpdate)
          .eq('id', existingCustomer.id);

        if (customerUpdateError) {
          return { ok: false, error: customerUpdateError.message };
        }

        customerId = existingCustomer.id;
      } else {
        const { data: insertedCustomer, error: customerInsertError } = await supabaseServiceClient
          .from('customer')
          .insert(customerData)
          .select('id')
          .single();

        if (customerInsertError) {
          return { ok: false, error: customerInsertError.message };
        }

        customerId = insertedCustomer.id;
      }
    }

    const orderData = mapShopifyOrder(orderNode, {
      merchantAccountId,
      shopId,
      customerId,
    });
    const shopifyOrderId = orderData.shopify_order_id;

    if (!shopifyOrderId) {
      return { ok: false, error: 'Shopify order is missing shopify_order_id' };
    }

    const { data: existingOrder, error: orderSelectError } = await supabaseServiceClient
      .from('orders')
      .select('id, cod_status, shopify_updated_at')
      .eq('merchant_account_id', merchantAccountId)
      .eq('shopify_order_id', shopifyOrderId)
      .maybeSingle();

    if (orderSelectError) {
      return { ok: false, error: orderSelectError.message };
    }

    if (existingOrder) {
      // Garde hors-ordre : ignorer un webhook plus ancien que le dernier déjà appliqué.
      const incoming = orderData.shopify_updated_at;
      const stored = existingOrder.shopify_updated_at;
      if (incoming && stored && Date.parse(incoming) <= Date.parse(stored)) {
        return { ok: true, skipped: 'stale' };
      }

      // JAMAIS les 4 dimensions (order_state/call_state/delivery_state/cash_state) : Shopify
      // n'écrase pas l'état opérationnel. On met à jour le contenu + le miroir de canal.
      const orderUpdate: OrderShopifyUpdate = {
        order_number: orderData.order_number,
        total_amount: orderData.total_amount,
        currency: orderData.currency,
        financial_status: orderData.financial_status,
        fulfillment_status: orderData.fulfillment_status,
        shopify_financial_status: orderData.shopify_financial_status,
        shopify_fulfillment_status: orderData.shopify_fulfillment_status,
        shopify_cancelled_at: orderData.shopify_cancelled_at,
        shopify_updated_at: orderData.shopify_updated_at,
        items_summary: orderData.items_summary,
        shipping_address: orderData.shipping_address,
        customer_id: orderData.customer_id,
        created_at_shopify: orderData.created_at_shopify,
        updated_at: new Date().toISOString(),
      };
      const { error: orderUpdateError } = await supabaseServiceClient
        .from('orders')
        .update(orderUpdate)
        .eq('id', existingOrder.id);

      if (orderUpdateError) {
        return { ok: false, error: orderUpdateError.message };
      }
    } else {
      const { data: insertedOrder, error: orderInsertError } = await supabaseServiceClient
        .from('orders')
        .insert(orderData)
        .select('id')
        .single();

      if (orderInsertError || !insertedOrder) {
        return { ok: false, error: orderInsertError?.message ?? 'Insert returned no row' };
      }

      // Best-effort: resolution failure never blocks ingestion.
      await resolveAndInsertOrderLines(supabaseServiceClient, {
        merchantAccountId,
        orderId: insertedOrder.id,
        lineItems: parseItemsummary(orderData.items_summary as Json),
      }).catch(() => undefined);
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Unknown sync error' };
  }
}
