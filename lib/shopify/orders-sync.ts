import { normalizeSenegalPhone } from '@/lib/address/phone-sn';
import {
  parseItemsummary,
  resolveAndInsertOrderLines,
  resolveOrderLines,
} from '@/lib/stock/order-line-resolution';
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
        note
        customAttributes { key value }
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        customer {
          id
          displayName
          firstName
          lastName
          phone
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
              customAttributes { key value }
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
  // Champs PCD strictement nécessaires au MVP COD ; les adaptateurs bulk JSONL et webhook REST
  // synthétisent la même forme.
  firstName?: string | null;
  lastName?: string | null;
  defaultAddress?: ShopifyAddress | null;
};

// Attribut clé/valeur générique (customAttributes GraphQL, "properties" ligne REST,
// note_attributes commande REST) — affichage brut uniquement, jamais interprété.
export type ShopifyCustomAttribute = {
  key: string;
  value: string | null;
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
  // Propriétés personnalisées par ligne (apps tierces) — capture générique, aucune automatisation.
  customAttributes?: ShopifyCustomAttribute[] | null;
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
  // Note commande + attributs personnalisés commande (apps tierces) — capture générique,
  // affichage brut uniquement.
  note?: string | null;
  customAttributes?: ShopifyCustomAttribute[] | null;
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
  phone: string | null;
  phone_e164: string | null;
  address: Json | null;
  shipping_address: Json | null;
  shopify_customer_gids: Json;
  shopify_customer_id: string | null;
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
  | 'shopify_order_attributes'
  | 'shopify_line_item_attributes'
>;

type ReplaceShopifyOrderCartArgs = {
  p_order_id: string;
  p_lines: Json;
  p_order_update: Json;
};

function replaceShopifyOrderCartRpc(client: { rpc: SupabaseClient<Database>['rpc'] }) {
  return client.rpc.bind(client) as unknown as (
    fn: 'replace_shopify_order_cart',
    args: ReplaceShopifyOrderCartArgs,
  ) => Promise<{ data: null; error: { message: string } | null }>;
}

export function shouldResyncShopifyOrderCart(
  existingOrder: Pick<
    TablesUpdate<'orders'>,
    'cart_locally_modified_at' | 'cash_state' | 'delivery_state'
  >,
): boolean {
  return (
    existingOrder.cart_locally_modified_at === null &&
    existingOrder.delivery_state === 'unassigned' &&
    existingOrder.cash_state === 'not_due'
  );
}

export function buildShopifyOrderUpdate(
  orderData: OrderUpsert,
  cartLocallyModifiedAt: string | null,
): OrderShopifyUpdate {
  const common = {
    order_number: orderData.order_number,
    currency: orderData.currency,
    financial_status: orderData.financial_status,
    fulfillment_status: orderData.fulfillment_status,
    shopify_financial_status: orderData.shopify_financial_status,
    shopify_fulfillment_status: orderData.shopify_fulfillment_status,
    shopify_cancelled_at: orderData.shopify_cancelled_at,
    shopify_updated_at: orderData.shopify_updated_at,
    shipping_address: orderData.shipping_address,
    customer_id: orderData.customer_id,
    created_at_shopify: orderData.created_at_shopify,
    updated_at: new Date().toISOString(),
    // Note/attributs personnalisés : jamais édités localement par le marchand (pas de garde
    // cart_locally_modified_at) — toujours rafraîchis, y compris sur une note ajoutée après coup
    // (même chemin orders/updated que le reste du miroir de canal).
    shopify_order_attributes: orderData.shopify_order_attributes,
    shopify_line_item_attributes: orderData.shopify_line_item_attributes,
  } satisfies Omit<OrderShopifyUpdate, 'items_summary' | 'total_amount'>;

  return cartLocallyModifiedAt
    ? common
    : { ...common, total_amount: orderData.total_amount, items_summary: orderData.items_summary };
}

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
  customerTombstoned?: boolean;
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

function joinName(
  first: string | null | undefined,
  last: string | null | undefined,
): string | null {
  const name = [first, last].filter(Boolean).join(' ').trim();
  return name || null;
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
    address: mapFlexibleAddress(flexibleSource),
    shipping_address: mapShippingAddress(node.shippingAddress),
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
    phone: existing.phone ?? incoming.phone ?? null,
    phone_e164: existing.phone_e164 ?? incoming.phone_e164 ?? null,
    address: existing.address ?? incoming.address ?? null,
    shipping_address: existing.shipping_address ?? incoming.shipping_address ?? null,
    shopify_customer_gids: mergeGids(existing.shopify_customer_gids, incoming.shopify_customer_id),
    shopify_customer_id: existing.shopify_customer_id ?? incoming.shopify_customer_id ?? null,
    updated_at: new Date().toISOString(),
  };
}

function normalizeAttributes(
  attributes: ShopifyCustomAttribute[] | null | undefined,
): Array<{ key: string; value: string | null }> {
  return (attributes ?? [])
    .filter((attribute): attribute is ShopifyCustomAttribute => Boolean(attribute.key?.trim()))
    .map((attribute) => ({ key: attribute.key, value: attribute.value ?? null }));
}

// Attributs de commande (note + customAttributes) — objet unique, null si rien à stocker
// (pas de section vide à l'affichage). Capture générique, jamais interprétée.
export function buildShopifyOrderAttributes(node: ShopifyOrderNode): Json | null {
  const note = node.note?.trim() ? node.note : null;
  const attributes = normalizeAttributes(node.customAttributes);

  if (!note && attributes.length === 0) {
    return null;
  }

  return { note, attributes } satisfies Json;
}

// Attributs par ligne — tableau parallèle à items_summary (même ordre), null si aucune ligne
// n'a d'attribut (pas de colonne polluée par des tableaux vides).
export function buildShopifyLineItemAttributes(node: ShopifyOrderNode): Json | null {
  const lines = node.lineItems.edges.map(({ node: lineItem }) => ({
    title: lineItem.title,
    attributes: normalizeAttributes(lineItem.customAttributes),
  }));

  const hasAny = lines.some((line) => line.attributes.length > 0);
  return hasAny ? (lines satisfies Json) : null;
}

export function mapShopifyOrder(
  node: ShopifyOrderNode,
  { merchantAccountId, shopId, customerId, customerTombstoned = false }: OrderMappingContext,
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
    shipping_address: customerTombstoned ? null : mapShippingAddress(node.shippingAddress),
    created_at_shopify: node.createdAt,
    shopify_order_attributes: customerTombstoned ? null : buildShopifyOrderAttributes(node),
    shopify_line_item_attributes: customerTombstoned ? null : buildShopifyLineItemAttributes(node),
  };
}

const MERGE_SELECT =
  'id, full_name, first_name, last_name, phone, phone_e164, address, shipping_address, shopify_customer_gids, shopify_customer_id';

// Dédup robuste à travers boutiques ET canaux : on cherche d'abord par téléphone E.164
// (identité principale), sinon par GID Shopify (tableau ou colonne legacy).
// Un match → fusion non destructive (union des GID, remplissage des trous PII). Sinon insert.
async function resolveShopifyCustomer(
  admin: SupabaseClient<Database>,
  merchantAccountId: string,
  shopId: string,
  incoming: CustomerUpsert,
): Promise<
  | { ok: true; customerId: string; tombstoned: false }
  | { ok: true; customerId: null; tombstoned: true }
  | { ok: false; error: string }
> {
  const phoneE164 = incoming.phone_e164 ?? null;
  const gid = incoming.shopify_customer_id ?? null;

  if (gid) {
    const { data: tombstone, error: tombstoneError } = await admin
      .from('shopify_customer_redaction_tombstone')
      .select('id')
      .eq('merchant_account_id', merchantAccountId)
      .eq('shop_id', shopId)
      .eq('shopify_customer_id', gid)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (tombstoneError) {
      return { ok: false, error: 'shopify_customer_tombstone_lookup_failed' };
    }
    if (tombstone) {
      return { ok: true, customerId: null, tombstoned: true };
    }
  }

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

  // 2. par GID Shopify : tableau (multi-boutiques) puis colonne legacy.
  if (!existing && gid) {
    const { data, error } = await admin
      .from('customer')
      .select(MERGE_SELECT)
      .eq('merchant_account_id', merchantAccountId)
      // jsonb containment : postgrest-js sérialise un tableau JS en littéral tableau Postgres
      // `{...}` (invalide en json → "invalid input syntax for type json") ; on passe une chaîne
      // JSON pour obtenir le filtre attendu `@> '["gid"]'::jsonb`.
      .contains('shopify_customer_gids', JSON.stringify([gid]))
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
    return { ok: true, customerId: existing.id, tombstoned: false };
  }

  const { data: inserted, error } = await admin
    .from('customer')
    .insert(incoming)
    .select('id')
    .single();
  if (error || !inserted) {
    return { ok: false, error: error?.message ?? 'Insert returned no row' };
  }
  return { ok: true, customerId: inserted.id, tombstoned: false };
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
    let customerTombstoned = false;

    if (customerData) {
      const resolved = await resolveShopifyCustomer(
        supabaseServiceClient,
        merchantAccountId,
        shopId,
        customerData,
      );
      if (!resolved.ok) {
        return { ok: false, error: resolved.error };
      }
      customerId = resolved.customerId;
      customerTombstoned = resolved.tombstoned;
    }

    const orderData = mapShopifyOrder(orderNode, {
      merchantAccountId,
      shopId,
      customerId,
      customerTombstoned,
    });
    const shopifyOrderId = orderData.shopify_order_id;

    if (!shopifyOrderId) {
      return { ok: false, error: 'Shopify order is missing shopify_order_id' };
    }

    const { data: existingOrder, error: orderSelectError } = await supabaseServiceClient
      .from('orders')
      .select(
        'id, cod_status, shopify_updated_at, cart_locally_modified_at, delivery_state, cash_state',
      )
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
      const orderUpdate = buildShopifyOrderUpdate(
        orderData,
        existingOrder.cart_locally_modified_at,
      );

      const orderUpdateError = shouldResyncShopifyOrderCart(existingOrder)
        ? (
            await replaceShopifyOrderCartRpc(supabaseServiceClient)('replace_shopify_order_cart', {
              p_order_id: existingOrder.id,
              p_lines: (
                await resolveOrderLines(supabaseServiceClient, {
                  merchantAccountId,
                  lineItems: parseItemsummary(orderData.items_summary as Json),
                })
              ).map(({ qty, ...line }) => ({ ...line, quantity: qty })) as unknown as Json,
              p_order_update: orderUpdate as unknown as Json,
            })
          ).error
        : (
            await supabaseServiceClient
              .from('orders')
              .update(orderUpdate)
              .eq('id', existingOrder.id)
          ).error;

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
