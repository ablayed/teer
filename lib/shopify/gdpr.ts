// Traitements GDPR Shopify. Les mutations de redaction sont exécutées par la
// RPC SQL transactionnelle 0121 : aucune étape intermédiaire n'est présentée
// comme réussie si une copie PCD échoue.

import type { Database, Json } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

type Scope = {
  merchantAccountId: string;
  shopId: string;
};

export type GdprProof = {
  customer_count: number;
  order_count: number;
  delivery_address_count: number;
  tombstone_count: number;
  webhook_payload_count: number;
};

export type CustomerDataExport = {
  customers: unknown[];
  orders: unknown[];
  delivery_addresses: unknown[];
};

function asJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function parseProof(value: unknown): GdprProof {
  const record = asJsonRecord(value);
  return {
    customer_count: asCount(record.customer_count),
    order_count: asCount(record.order_count),
    delivery_address_count: asCount(record.delivery_address_count),
    tombstone_count: asCount(record.tombstone_count),
    webhook_payload_count: asCount(record.webhook_payload_count),
  };
}

function assertSupabase<T extends { error: { message: string } | null }>(
  result: T,
  operation: string,
): asserts result is T & { error: null } {
  if (result.error) {
    throw new Error(`${operation}_failed`);
  }
}

async function findCustomerIdsByShopifyId(
  admin: AdminClient,
  { merchantAccountId, shopId }: Scope,
  shopifyCustomerId: string,
): Promise<string[]> {
  const { data: customerRows, error: customerError } = await admin
    .from('customer')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    .or(
      `shopify_customer_id.eq.${shopifyCustomerId},shopify_customer_gids.cs.${JSON.stringify([
        shopifyCustomerId,
      ])}`,
    );
  assertSupabase({ error: customerError }, 'gdpr_customer_lookup');

  if (!customerRows || customerRows.length === 0) {
    return [];
  }

  const candidateIds = customerRows.map((row) => row.id);
  const { data: shopOrders, error: orderError } = await admin
    .from('orders')
    .select('customer_id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('shop_id', shopId)
    .in('customer_id', candidateIds);
  assertSupabase({ error: orderError }, 'gdpr_customer_shop_scope_lookup');

  return [
    ...new Set(
      (shopOrders ?? [])
        .map((row) => row.customer_id)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
}

// DSAR : seules les données de la boutique qui a émis la demande sont
// exportées. Les journaux internes, payloads webhook et artefacts ne sont pas
// destinés à la personne concernée.
export async function compileCustomerData(
  admin: AdminClient,
  { merchantAccountId, shopId, shopifyCustomerId }: Scope & { shopifyCustomerId: string },
): Promise<CustomerDataExport> {
  const ids = await findCustomerIdsByShopifyId(
    admin,
    { merchantAccountId, shopId },
    shopifyCustomerId,
  );
  if (ids.length === 0) {
    return { customers: [], orders: [], delivery_addresses: [] };
  }

  const customersResult = await admin
    .from('customer')
    .select(
      'id, full_name, first_name, last_name, phone, phone_e164, address, shipping_address, created_at',
    )
    .eq('merchant_account_id', merchantAccountId)
    .in('id', ids);
  const ordersResult = await admin
    .from('orders')
    .select(
      'id, order_number, total_amount, currency, shipping_address, note, shopify_order_attributes, shopify_line_item_attributes, created_at_shopify',
    )
    .eq('merchant_account_id', merchantAccountId)
    .eq('shop_id', shopId)
    .in('customer_id', ids);

  assertSupabase({ error: customersResult.error }, 'gdpr_customer_export');
  assertSupabase({ error: ordersResult.error }, 'gdpr_order_export');

  const orderIds = (ordersResult.data ?? []).map((order) => order.id);
  const addressFilter = [
    `customer_id.in.(${ids.join(',')})`,
    ...(orderIds.length > 0 ? [`order_id.in.(${orderIds.join(',')})`] : []),
  ].join(',');
  const addressesResult = await admin
    .from('delivery_address')
    .select(
      'id, customer_id, order_id, quartier_commune, ville, repere, indications_acces, telephone_principal, telephone_alternatif, gps_lat, gps_lng, created_at',
    )
    .eq('merchant_account_id', merchantAccountId)
    .or(addressFilter);
  assertSupabase({ error: addressesResult.error }, 'gdpr_delivery_address_export');

  return {
    customers: customersResult.data ?? [],
    orders: ordersResult.data ?? [],
    delivery_addresses: addressesResult.data ?? [],
  };
}

async function redactCopies(
  admin: AdminClient,
  {
    merchantAccountId,
    shopId,
    shopifyCustomerId,
    topic,
    webhookEventId,
  }: Scope & {
    shopifyCustomerId: string | null;
    topic: 'customers/redact' | 'shop/redact';
    webhookEventId: string;
  },
): Promise<GdprProof> {
  const { data, error } = await admin.rpc('redact_shopify_customer_copies', {
    p_merchant_account_id: merchantAccountId,
    p_shop_id: shopId,
    p_shopify_customer_id: shopifyCustomerId as string,
    p_topic: topic,
    p_webhook_event_id: webhookEventId,
  });
  assertSupabase({ error }, 'gdpr_redaction');
  return parseProof(data);
}

export async function redactCustomer(
  admin: AdminClient,
  {
    merchantAccountId,
    shopId,
    shopifyCustomerId,
    webhookEventId,
  }: Scope & { shopifyCustomerId: string; webhookEventId: string },
): Promise<GdprProof> {
  return redactCopies(admin, {
    merchantAccountId,
    shopId,
    shopifyCustomerId,
    webhookEventId,
    topic: 'customers/redact',
  });
}

export async function redactShop(
  admin: AdminClient,
  { shopId, merchantAccountId, webhookEventId }: Scope & { webhookEventId: string },
): Promise<GdprProof> {
  return redactCopies(admin, {
    merchantAccountId,
    shopId,
    shopifyCustomerId: null,
    webhookEventId,
    topic: 'shop/redact',
  });
}

export function toGdprAuditPayload({
  artifactId,
  artifactExpiresAt,
  proof,
  status,
  topic,
}: {
  artifactId?: string | null;
  artifactExpiresAt?: string | null;
  proof?: Partial<GdprProof>;
  status: 'done' | 'retryable' | 'terminal';
  topic: string;
}): Json {
  return {
    topic,
    status,
    artifact_id: artifactId ?? null,
    artifact_expires_at: artifactExpiresAt ?? null,
    counts: {
      customer_count: proof?.customer_count ?? 0,
      order_count: proof?.order_count ?? 0,
      delivery_address_count: proof?.delivery_address_count ?? 0,
      tombstone_count: proof?.tombstone_count ?? 0,
      webhook_payload_count: proof?.webhook_payload_count ?? 0,
    },
  };
}
