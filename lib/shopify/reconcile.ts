// Réconciliation nocturne / fallback bulk (Phase 7a).
// Re-pull bulk des commandes modifiées depuis last_reconciled_at, persistées de façon idempotente
// (upsert par (shop_id, shopify_order_id), miroir de canal, garde hors-ordre) → rattrape les
// webhooks ratés. N'écrase JAMAIS l'état opérationnel (4 dimensions).

import { writePcdAccessAudit } from '@/lib/security/pcd-access-audit';
import {
  type BulkOperation,
  downloadJsonl,
  parseBulkOrdersJsonl,
  pollBulkOperation,
  startBulkOrdersOperation,
  waitForBulkCompletion,
} from '@/lib/shopify/bulk';
import { persistShopifyOrder } from '@/lib/shopify/orders-sync';
import { getValidShopAccessToken } from '@/lib/shopify/token';
import type { Database, Tables } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;
type ShopRow = Tables<'shop'>;

export type ReconcileResult =
  | { ok: true; syncedCount: number; failedCount: number }
  | { ok: false; reason: 'needs_reauth' | 'token_error' | 'bulk_failed' };

async function persistBulkOrders(
  admin: AdminClient,
  shop: ShopRow,
  operation: BulkOperation,
): Promise<{ syncedCount: number; failedCount: number }> {
  // objectCount 0 → url null (aucune commande modifiée).
  if (!operation.url) {
    return { syncedCount: 0, failedCount: 0 };
  }

  const jsonl = await downloadJsonl(operation.url);
  const nodes = parseBulkOrdersJsonl(jsonl);

  try {
    await writePcdAccessAudit(admin, {
      tenantId: shop.merchant_account_id,
      shopId: shop.id,
      actorKind: 'service',
      serviceKind: 'shopify_sync',
      action: 'privileged_read',
      dataCategory: 'shopify_payload',
      purpose: 'system_processing',
      outcome: 'allowed',
      resourceType: 'shopify_payload',
      surface: 'shopify',
      metadata: { result_count: Math.min(nodes.length, 500), source: 'bulk' },
    });
  } catch {
    return { syncedCount: 0, failedCount: nodes.length };
  }

  let syncedCount = 0;
  let failedCount = 0;
  for (const node of nodes) {
    const result = await persistShopifyOrder({
      merchantAccountId: shop.merchant_account_id,
      orderNode: node,
      shopId: shop.id,
      supabaseServiceClient: admin,
    });
    if (result.ok) {
      syncedCount += 1;
    } else {
      failedCount += 1;
    }
  }

  await admin
    .from('shop')
    .update({ last_reconciled_at: new Date().toISOString() })
    .eq('id', shop.id);

  return { syncedCount, failedCount };
}

// Démarre une bulk operation (commandes modifiées depuis last_reconciled_at) et la traite
// avec fallback polling (la livraison du webhook bulk_operations/finish n'est pas garantie).
export async function reconcileShopOrders(
  admin: AdminClient,
  shop: ShopRow,
  clientId: string,
  clientSecret: string,
): Promise<ReconcileResult> {
  const token = await getValidShopAccessToken(admin, shop, clientId, clientSecret);
  if (!token.ok) {
    return { ok: false, reason: token.reason };
  }

  try {
    await startBulkOrdersOperation(shop.shop_domain, token.accessToken, shop.last_reconciled_at);
    const operation = await waitForBulkCompletion(shop.shop_domain, token.accessToken);
    if (operation.status !== 'COMPLETED') {
      return { ok: false, reason: 'bulk_failed' };
    }
    const { syncedCount, failedCount } = await persistBulkOrders(admin, shop, operation);
    return { ok: true, syncedCount, failedCount };
  } catch {
    return { ok: false, reason: 'bulk_failed' };
  }
}

// Traite une bulk operation déjà terminée (déclenché par le webhook bulk_operations/finish).
export async function processFinishedBulkForShop(
  admin: AdminClient,
  shop: ShopRow,
  clientId: string,
  clientSecret: string,
): Promise<ReconcileResult> {
  const token = await getValidShopAccessToken(admin, shop, clientId, clientSecret);
  if (!token.ok) {
    return { ok: false, reason: token.reason };
  }

  try {
    const operation = await pollBulkOperation(shop.shop_domain, token.accessToken);
    if (!operation || operation.status !== 'COMPLETED') {
      return { ok: false, reason: 'bulk_failed' };
    }
    const { syncedCount, failedCount } = await persistBulkOrders(admin, shop, operation);
    return { ok: true, syncedCount, failedCount };
  } catch {
    return { ok: false, reason: 'bulk_failed' };
  }
}
