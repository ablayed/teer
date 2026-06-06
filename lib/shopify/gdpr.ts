// Conformité GDPR Shopify (Phase 7a) — handlers réels (gate de publication).
// La PII client de Tëër vit dans `customer` (full_name/phone/email/shipping_address) et dans
// `orders.shipping_address`. On conserve ce qui est légalement requis (montants/statuts comptables).

import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

const REDACTED_NAME = '[client supprimé]';

// customers/data_request : compile les données détenues sur ce client pour ce marchand.
export async function compileCustomerData(
  admin: AdminClient,
  {
    merchantAccountId,
    shopifyCustomerId,
  }: { merchantAccountId: string; shopifyCustomerId: string },
): Promise<{ customer: unknown; orders: unknown[] }> {
  const { data: customer } = await admin
    .from('customer')
    .select('id, full_name, phone, email, shipping_address, created_at')
    .eq('merchant_account_id', merchantAccountId)
    .eq('shopify_customer_id', shopifyCustomerId)
    .maybeSingle();

  let orders: unknown[] = [];
  if (customer) {
    const { data: orderRows } = await admin
      .from('orders')
      .select('id, order_number, total_amount, currency, shipping_address, created_at_shopify')
      .eq('merchant_account_id', merchantAccountId)
      .eq('customer_id', (customer as { id: string }).id);
    orders = orderRows ?? [];
  }

  return { customer: customer ?? null, orders };
}

// Anonymise un client : on retire la PII (nom/téléphone/email/adresse) en gardant la ligne
// (et shopify_customer_id) pour le rattachement comptable des commandes déjà passées.
async function anonymizeCustomerRows(admin: AdminClient, customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) return;
  await admin
    .from('customer')
    .update({
      full_name: REDACTED_NAME,
      phone: null,
      email: null,
      shipping_address: null,
      updated_at: new Date().toISOString(),
    })
    .in('id', customerIds);
}

async function nullOrdersShippingAddress(admin: AdminClient, customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) return;
  await admin
    .from('orders')
    .update({ shipping_address: null, updated_at: new Date().toISOString() })
    .in('customer_id', customerIds);
}

// customers/redact : supprime la PII de CE client pour ce marchand.
export async function redactCustomer(
  admin: AdminClient,
  {
    merchantAccountId,
    shopifyCustomerId,
  }: { merchantAccountId: string; shopifyCustomerId: string },
): Promise<{ redactedCustomerCount: number }> {
  const { data: customers } = await admin
    .from('customer')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('shopify_customer_id', shopifyCustomerId);

  const ids = (customers ?? []).map((c) => (c as { id: string }).id);
  await anonymizeCustomerRows(admin, ids);
  await nullOrdersShippingAddress(admin, ids);
  return { redactedCustomerCount: ids.length };
}

// shop/redact : 48 h après désinstallation, efface toute la PII client liée à CETTE boutique
// (clients rattachés aux commandes de la boutique).
export async function redactShop(
  admin: AdminClient,
  { shopId, merchantAccountId }: { shopId: string; merchantAccountId: string },
): Promise<{ redactedCustomerCount: number }> {
  const { data: shopOrders } = await admin
    .from('orders')
    .select('customer_id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('shop_id', shopId)
    .not('customer_id', 'is', null);

  const customerIds = [
    ...new Set(
      (shopOrders ?? [])
        .map((o) => (o as { customer_id: string | null }).customer_id)
        .filter((id): id is string => id !== null),
    ),
  ];

  await anonymizeCustomerRows(admin, customerIds);
  // Null les adresses de livraison de toutes les commandes de la boutique (PII).
  await admin
    .from('orders')
    .update({ shipping_address: null, updated_at: new Date().toISOString() })
    .eq('merchant_account_id', merchantAccountId)
    .eq('shop_id', shopId);

  return { redactedCustomerCount: customerIds.length };
}
