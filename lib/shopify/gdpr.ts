// Conformité GDPR Shopify (Phase 7a, PII réelle en Phase 7b) — handlers réels (gate de publication).
// La PII client de Tëër vit dans `customer` (nom/prénoms/téléphone/phone_e164/adresse flexible/
// adresse de livraison/tags/consentement) et dans `orders.shipping_address`. On conserve ce qui est
// légalement requis (montants/statuts comptables sur orders ; agrégats Shopify non identifiants).
//
// Dédup multi-boutiques (7b) : un client peut porter plusieurs GID Shopify dans
// `shopify_customer_gids`. On retrouve donc un client par la colonne legacy `shopify_customer_id`
// ET par le tableau de GID.

import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

const REDACTED_NAME = '[client supprimé]';

// Retrouve les clients de ce marchand rattachés à un identifiant client Shopify (numérique),
// via la colonne legacy shopify_customer_id ET le tableau shopify_customer_gids.
async function findCustomerIdsByShopifyId(
  admin: AdminClient,
  merchantAccountId: string,
  shopifyCustomerId: string,
): Promise<string[]> {
  const ids = new Set<string>();

  const { data: byLegacy } = await admin
    .from('customer')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('shopify_customer_id', shopifyCustomerId);
  for (const row of byLegacy ?? []) {
    ids.add((row as { id: string }).id);
  }

  const { data: byGid } = await admin
    .from('customer')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    // jsonb containment : passer une chaîne JSON (et non un tableau JS) — sinon postgrest-js émet
    // un littéral tableau Postgres `{...}` invalide en json. Cf. lib/shopify/orders-sync.ts.
    .contains('shopify_customer_gids', JSON.stringify([shopifyCustomerId]));
  for (const row of byGid ?? []) {
    ids.add((row as { id: string }).id);
  }

  return [...ids];
}

// customers/data_request : compile TOUT ce qu'on détient sur ce client pour ce marchand.
export async function compileCustomerData(
  admin: AdminClient,
  {
    merchantAccountId,
    shopifyCustomerId,
  }: { merchantAccountId: string; shopifyCustomerId: string },
): Promise<{ customers: unknown[]; orders: unknown[] }> {
  const ids = await findCustomerIdsByShopifyId(admin, merchantAccountId, shopifyCustomerId);
  if (ids.length === 0) {
    return { customers: [], orders: [] };
  }

  const { data: customers } = await admin
    .from('customer')
    .select(
      'id, full_name, first_name, last_name, phone, phone_e164, address, shipping_address, tags, accepts_marketing, shopify_orders_count, shopify_amount_spent_minor, first_seen_at, created_at',
    )
    .in('id', ids);

  const { data: orders } = await admin
    .from('orders')
    .select('id, order_number, total_amount, currency, shipping_address, created_at_shopify')
    .eq('merchant_account_id', merchantAccountId)
    .in('customer_id', ids);

  return { customers: customers ?? [], orders: orders ?? [] };
}

// Anonymise un client : on efface TOUTE la PII directe (nom/prénoms/téléphone/phone_e164/
// adresse flexible/adresse de livraison/tags/consentement) en gardant la ligne et les identifiants
// Shopify (shopify_customer_id/gids) + agrégats non identifiants pour le rattachement comptable.
async function anonymizeCustomerRows(admin: AdminClient, customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) {
    return;
  }
  await admin
    .from('customer')
    .update({
      full_name: REDACTED_NAME,
      first_name: null,
      last_name: null,
      phone: null,
      phone_e164: null,
      address: null,
      shipping_address: null,
      tags: null,
      accepts_marketing: null,
      updated_at: new Date().toISOString(),
    })
    .in('id', customerIds);
}

async function nullOrdersShippingAddress(admin: AdminClient, customerIds: string[]): Promise<void> {
  if (customerIds.length === 0) {
    return;
  }
  await admin
    .from('orders')
    .update({ shipping_address: null, updated_at: new Date().toISOString() })
    .in('customer_id', customerIds);
}

// customers/redact : supprime la PII de CE client pour ce marchand (à travers ses boutiques).
export async function redactCustomer(
  admin: AdminClient,
  {
    merchantAccountId,
    shopifyCustomerId,
  }: { merchantAccountId: string; shopifyCustomerId: string },
): Promise<{ redactedCustomerCount: number }> {
  const ids = await findCustomerIdsByShopifyId(admin, merchantAccountId, shopifyCustomerId);
  await anonymizeCustomerRows(admin, ids);
  await nullOrdersShippingAddress(admin, ids);
  return { redactedCustomerCount: ids.length };
}

// shop/redact : 48 h après désinstallation, efface la PII client liée à CETTE boutique.
// Dédup multi-boutiques oblige : on n'anonymise QUE les clients EXCLUSIFS à cette boutique
// (sans aucune commande dans une autre boutique ni manuelle) — un client encore actif ailleurs
// chez le même marchand garde une base légale. On nulle toujours les adresses des commandes
// de la boutique.
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

  const candidateIds = [
    ...new Set(
      (shopOrders ?? [])
        .map((o) => (o as { customer_id: string | null }).customer_id)
        .filter((id): id is string => id !== null),
    ),
  ];

  let exclusiveIds = candidateIds;
  if (candidateIds.length > 0) {
    // Clients ayant AUSSI une commande hors de cette boutique (autre shop_id, ou manuelle null).
    const { data: otherOrders } = await admin
      .from('orders')
      .select('customer_id')
      .eq('merchant_account_id', merchantAccountId)
      .in('customer_id', candidateIds)
      .or(`shop_id.neq.${shopId},shop_id.is.null`);

    const sharedIds = new Set(
      (otherOrders ?? [])
        .map((o) => (o as { customer_id: string | null }).customer_id)
        .filter((id): id is string => id !== null),
    );
    exclusiveIds = candidateIds.filter((id) => !sharedIds.has(id));
  }

  await anonymizeCustomerRows(admin, exclusiveIds);

  // Null les adresses de livraison de toutes les commandes de la boutique (PII).
  await admin
    .from('orders')
    .update({ shipping_address: null, updated_at: new Date().toISOString() })
    .eq('merchant_account_id', merchantAccountId)
    .eq('shop_id', shopId);

  return { redactedCustomerCount: exclusiveIds.length };
}
