import type { Json, TablesInsert } from '@/lib/supabase/database.types';

export const SHOPIFY_ORDERS_QUERY = `
query Orders($cursor: String) {
  orders(first: 50, after: $cursor, sortKey: CREATED_AT, reverse: true) {
    edges {
      cursor
      node {
        id
        name
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        customer { id displayName phone email }
        shippingAddress { address1 address2 city province country zip phone name }
        lineItems(first: 20) {
          edges { node { title quantity originalUnitPriceSet { shopMoney { amount } } } }
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
  quantity: number;
  originalUnitPriceSet: {
    shopMoney: {
      amount: string;
    };
  };
};

export type ShopifyOrderNode = {
  id: string;
  name: string;
  createdAt: string | null;
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
    items_summary: node.lineItems.edges.map(({ node: lineItem }) => ({
      title: lineItem.title,
      quantity: lineItem.quantity,
      price: parseAmount(lineItem.originalUnitPriceSet.shopMoney.amount),
    })),
    shipping_address: mapShippingAddress(node.shippingAddress),
    created_at_shopify: node.createdAt,
  };
}
