import { normalizeSenegalPhone } from '@/lib/address/phone-sn';
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
        customer {
          id
          displayName
          firstName
          lastName
          phone
          email
          numberOfOrders
          amountSpent { amount currencyCode }
          tags
          emailMarketingConsent { marketingState }
          createdAt
          defaultAddress { address1 address2 city province country zip phone name }
        }
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
  // Champs d'enrichissement (Phase 7b). Forme GraphQL brute ; les adaptateurs bulk JSONL et
  // webhook REST synthétisent la MÊME forme. La normalisation (string→int, consentement→bool)
  // se fait dans mapShopifyCustomer.
  firstName?: string | null;
  lastName?: string | null;
  // numberOfOrders : GraphQL renvoie un UnsignedInt64 (string) ; REST orders_count (number).
  numberOfOrders?: number | string | null;
  amountSpent?: ShopifyMoney | null;
  tags?: string[] | null;
  emailMarketingConsent?: { marketingState: string | null } | null;
  defaultAddress?: ShopifyAddress | null;
  createdAt?: string | null;
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
// Sous-ensemble des colonnes client nécessaires à la fusion (dédup) — sélectionné en base.
export type ExistingCustomerForMerge = {
  id: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  phone_e164: string | null;
  address: Json | null;
  shipping_address: Json | null;
  tags: string[] | null;
  accepts_marketing: boolean | null;
  shopify_customer_gids: Json;
  shopify_customer_id: string | null;
  shopify_orders_count: number | null;
  shopify_amount_spent_minor: number | null;
};
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

// Garde hors-ordre : un webhook est périmé si son updated_at est antérieur ou égal à celui
// déjà appliqué (shopify_updated_at stocké). Si l'un des deux manque, on n'a pas de quoi
// décider → non périmé (on applique).
export function isStaleShopifyUpdate(
  incoming: string | null | undefined,
  stored: string | null | undefined,
): boolean {
  if (!incoming || !stored) {
    return false;
  }
  return Date.parse(incoming) <= Date.parse(stored);
}

// Adresse flexible (adressage sénégalais informel) : repère/quartier/ville, pas de code postal.
// Construite depuis defaultAddress (préféré) ou l'adresse de livraison.
export function mapFlexibleAddress(address: ShopifyAddress | null | undefined): Json | null {
  if (!address) {
    return null;
  }

  const raw = [address.address1, address.address2, address.city, address.province]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(', ');

  return {
    raw: raw || null,
    landmark: address.address2 ?? null,
    quartier: null,
    city: address.city ?? null,
    region: address.province ?? null,
    notes: null,
  };
}

// Montant Shopify (chaîne décimale en unité majeure) → bigint en unité mineure.
// FCFA est à 0 décimale : l'unité mineure = l'entier FCFA. Hint d'affichage, pas un calcul finance.
export function parseAmountToMinor(amount: string | null | undefined): number | null {
  if (!amount) {
    return null;
  }
  const value = Number.parseFloat(amount);
  return Number.isFinite(value) ? Math.round(value) : null;
}

function toIntOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function joinName(
  first: string | null | undefined,
  last: string | null | undefined,
): string | null {
  const name = [first, last].filter(Boolean).join(' ').trim();
  return name || null;
}

// Consentement marketing : SUBSCRIBED (insensible à la casse) → true ; autre état → false ;
// bloc absent → null (on ne présume rien).
function deriveAcceptsMarketing(
  consent: { marketingState: string | null } | null | undefined,
): boolean | null {
  if (!consent || !consent.marketingState) {
    return null;
  }
  return consent.marketingState.toUpperCase() === 'SUBSCRIBED';
}

export function mapShopifyCustomer(
  node: ShopifyOrderNode,
  merchantAccountId: string,
): CustomerUpsert | null {
  const customer = node.customer;
  if (!customer) {
    return null;
  }

  const gid = extractShopifyId(customer.id);
  const rawPhone = customer.phone ?? node.shippingAddress?.phone ?? null;
  const flexibleSource = customer.defaultAddress ?? node.shippingAddress ?? null;

  return {
    merchant_account_id: merchantAccountId,
    source: 'shopify',
    shopify_customer_id: gid,
    shopify_customer_gids: [gid],
    full_name:
      customer.displayName ??
      joinName(customer.firstName, customer.lastName) ??
      node.shippingAddress?.name ??
      null,
    first_name: customer.firstName ?? null,
    last_name: customer.lastName ?? null,
    phone: rawPhone,
    phone_e164: rawPhone ? normalizeSenegalPhone(rawPhone) : null,
    email: customer.email,
    accepts_marketing: deriveAcceptsMarketing(customer.emailMarketingConsent),
    tags: customer.tags ?? null,
    address: mapFlexibleAddress(flexibleSource),
    shipping_address: mapShippingAddress(node.shippingAddress),
    shopify_orders_count: toIntOrNull(customer.numberOfOrders),
    shopify_amount_spent_minor: parseAmountToMinor(customer.amountSpent?.amount),
    first_seen_at: customer.createdAt ?? null,
  };
}

// Union des GID Shopify (dédup) : on ajoute le GID entrant s'il manque.
export function mergeGids(existing: Json, incomingGid: string | null | undefined): string[] {
  const arr = Array.isArray(existing)
    ? existing.filter((value): value is string => typeof value === 'string')
    : [];
  if (incomingGid && !arr.includes(incomingGid)) {
    arr.push(incomingGid);
  }
  return arr;
}

// Fusion NON destructive : on garde la PII existante non vide, on remplit les trous depuis
// l'entrant. Les compteurs Shopify sont la dernière valeur connue (autoritative côté Shopify)
// quand fournie. Les GID sont unionnés. La source d'origine n'est jamais écrasée.
export function buildCustomerMergePatch(
  existing: ExistingCustomerForMerge,
  incoming: CustomerUpsert,
): TablesUpdate<'customer'> {
  return {
    full_name: existing.full_name ?? incoming.full_name ?? null,
    first_name: existing.first_name ?? incoming.first_name ?? null,
    last_name: existing.last_name ?? incoming.last_name ?? null,
    email: existing.email ?? incoming.email ?? null,
    phone: existing.phone ?? incoming.phone ?? null,
    phone_e164: existing.phone_e164 ?? incoming.phone_e164 ?? null,
    address: existing.address ?? incoming.address ?? null,
    shipping_address: existing.shipping_address ?? incoming.shipping_address ?? null,
    tags: existing.tags ?? incoming.tags ?? null,
    accepts_marketing: existing.accepts_marketing ?? incoming.accepts_marketing ?? null,
    shopify_orders_count: incoming.shopify_orders_count ?? existing.shopify_orders_count ?? null,
    shopify_amount_spent_minor:
      incoming.shopify_amount_spent_minor ?? existing.shopify_amount_spent_minor ?? null,
    shopify_customer_gids: mergeGids(existing.shopify_customer_gids, incoming.shopify_customer_id),
    shopify_customer_id: existing.shopify_customer_id ?? incoming.shopify_customer_id ?? null,
    updated_at: new Date().toISOString(),
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

const MERGE_SELECT =
  'id, full_name, first_name, last_name, email, phone, phone_e164, address, shipping_address, tags, accepts_marketing, shopify_customer_gids, shopify_customer_id, shopify_orders_count, shopify_amount_spent_minor';

// Dédup robuste à travers boutiques ET canaux : on cherche d'abord par téléphone E.164
// (identité principale), sinon par email, sinon par GID Shopify (tableau ou colonne legacy).
// Un match → fusion non destructive (union des GID, remplissage des trous PII). Sinon insert.
async function resolveShopifyCustomer(
  admin: SupabaseClient<Database>,
  merchantAccountId: string,
  incoming: CustomerUpsert,
): Promise<{ ok: true; customerId: string } | { ok: false; error: string }> {
  const phoneE164 = incoming.phone_e164 ?? null;
  const email = incoming.email ?? null;
  const gid = incoming.shopify_customer_id ?? null;

  let existing: ExistingCustomerForMerge | null = null;

  // 1. par téléphone E.164 (clé d'identité principale).
  if (phoneE164) {
    const { data, error } = await admin
      .from('customer')
      .select(MERGE_SELECT)
      .eq('merchant_account_id', merchantAccountId)
      .eq('phone_e164', phoneE164)
      .maybeSingle();
    if (error) {
      return { ok: false, error: error.message };
    }
    existing = data;
  }

  // 2. par email (clé secondaire), insensible à la casse.
  if (!existing && email) {
    const { data, error } = await admin
      .from('customer')
      .select(MERGE_SELECT)
      .eq('merchant_account_id', merchantAccountId)
      .ilike('email', email)
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) {
      return { ok: false, error: error.message };
    }
    existing = data?.[0] ?? null;
  }

  // 3. par GID Shopify : tableau (multi-boutiques) puis colonne legacy.
  if (!existing && gid) {
    const { data, error } = await admin
      .from('customer')
      .select(MERGE_SELECT)
      .eq('merchant_account_id', merchantAccountId)
      .contains('shopify_customer_gids', [gid])
      .limit(1);
    if (error) {
      return { ok: false, error: error.message };
    }
    existing = data?.[0] ?? null;

    if (!existing) {
      const { data: legacy, error: legacyError } = await admin
        .from('customer')
        .select(MERGE_SELECT)
        .eq('merchant_account_id', merchantAccountId)
        .eq('shopify_customer_id', gid)
        .maybeSingle();
      if (legacyError) {
        return { ok: false, error: legacyError.message };
      }
      existing = legacy;
    }
  }

  if (existing) {
    const patch = buildCustomerMergePatch(existing, incoming);
    const { error } = await admin.from('customer').update(patch).eq('id', existing.id);
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true, customerId: existing.id };
  }

  const { data: inserted, error } = await admin
    .from('customer')
    .insert(incoming)
    .select('id')
    .single();
  if (error || !inserted) {
    return { ok: false, error: error?.message ?? 'Insert returned no row' };
  }
  return { ok: true, customerId: inserted.id };
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

    if (customerData) {
      const resolved = await resolveShopifyCustomer(
        supabaseServiceClient,
        merchantAccountId,
        customerData,
      );
      if (!resolved.ok) {
        return { ok: false, error: resolved.error };
      }
      customerId = resolved.customerId;
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
      if (isStaleShopifyUpdate(orderData.shopify_updated_at, existingOrder.shopify_updated_at)) {
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
