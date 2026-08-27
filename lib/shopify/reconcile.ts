// Réconciliation nocturne / fallback bulk (Phase 7a).
// Re-pull bulk des commandes modifiées depuis last_reconciled_at, persistées de façon idempotente
// (upsert par (shop_id, shopify_order_id), miroir de canal, garde hors-ordre) → rattrape les
// webhooks ratés. N'écrase JAMAIS l'état opérationnel (4 dimensions).
//
// Lot R1 (Phase F) — le curseur `last_reconciled_at` ne doit jamais dépasser une commande dont
// la persistance a échoué : sinon elle n'est plus jamais reprise (le passage suivant part de
// `updated_at >= last_reconciled_at`, filtre inclusif côté Shopify — voir `bulk.ts`). Avant ce
// lot, le curseur avançait inconditionnellement après la boucle, y compris en cas d'échec.

import { writePcdAccessAudit } from '@/lib/security/pcd-access-audit';
import {
  type BulkOperation,
  downloadJsonl,
  parseBulkOrdersJsonl,
  pollBulkOperation,
  startBulkOrdersOperation,
  waitForBulkCompletion,
} from '@/lib/shopify/bulk';
import { type ShopifyOrderNode, persistShopifyOrder } from '@/lib/shopify/orders-sync';
import { getValidShopAccessToken } from '@/lib/shopify/token';
import type { Database, Tables } from '@/lib/supabase/database.types';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;
type ShopRow = Tables<'shop'>;

export type ReconcileResult =
  | {
      ok: true;
      syncedCount: number;
      failedCount: number;
      examinedCount: number;
      cursorBefore: string | null;
      cursorAfter: string | null;
    }
  | { ok: false; reason: 'needs_reauth' | 'token_error' | 'bulk_failed' };

type PersistOutcome = {
  syncedCount: number;
  failedCount: number;
  examinedCount: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
};

type NodeOutcome = { shopifyOrderId: string | null; updatedAt: string | null; ok: boolean };

// Le curseur ne doit jamais dépasser une commande en échec, faute de quoi elle n'est plus jamais
// reprise automatiquement (règle acquise du lot R1). Fonction pure, testée exhaustivement en
// isolation (tests/unit/shopify-reconcile-cursor.test.ts) :
// - Aucun échec → avance jusqu'à `runStartedAt` (capturé AVANT le lancement de la bulk operation,
//   jamais après le traitement — une borne prise après serait plus tardive que l'état réellement
//   exporté par Shopify et pourrait faire sauter une commande modifiée pendant le traitement).
// - Au moins un échec dont le `updated_at` Shopify est exploitable → s'arrête au plus ancien de
//   ces `updated_at`, quel que soit le nombre de succès autour (le filtre bulk est `>=`, inclusif :
//   cette commande sera bien reproposée au passage suivant).
// - Un échec dont le `updated_at` est inexploitable (absent/invalide) ne permet aucune borne sûre
//   → le curseur n'avance PAS du tout (reste à `previousCursor`), plutôt que de deviner.
export function computeNextReconcileCursor(
  previousCursor: string | null,
  runStartedAt: string,
  outcomes: NodeOutcome[],
): string | null {
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length === 0) {
    return runStartedAt;
  }

  const timestamps = failed.map((o) => (o.updatedAt ? Date.parse(o.updatedAt) : Number.NaN));
  if (timestamps.some((ms) => !Number.isFinite(ms))) {
    return previousCursor;
  }

  return new Date(Math.min(...timestamps)).toISOString();
}

// Traite un lot de nœuds déjà téléchargés/parsés (séparé de `persistBulkOrders` pour être
// testable contre une vraie base locale sans dépendre du réseau Shopify — tests/rls).
export async function persistBulkOrderNodes(
  admin: AdminClient,
  shop: ShopRow,
  nodes: ShopifyOrderNode[],
  runStartedAt: string,
): Promise<PersistOutcome> {
  const cursorBefore = shop.last_reconciled_at;

  if (nodes.length === 0) {
    const cursorAfter = runStartedAt;
    await admin.from('shop').update({ last_reconciled_at: cursorAfter }).eq('id', shop.id);
    return { syncedCount: 0, failedCount: 0, examinedCount: 0, cursorBefore, cursorAfter };
  }

  const outcomes: NodeOutcome[] = [];
  let syncedCount = 0;
  let failedCount = 0;

  for (const node of nodes) {
    const result = await persistShopifyOrder({
      merchantAccountId: shop.merchant_account_id,
      orderNode: node,
      shopId: shop.id,
      supabaseServiceClient: admin,
    });

    outcomes.push({ shopifyOrderId: node.id, updatedAt: node.updatedAt ?? null, ok: result.ok });

    if (result.ok) {
      syncedCount += 1;
    } else {
      failedCount += 1;
      // Aucune donnée client dans le message : identifiants techniques uniquement.
      Sentry.captureMessage('Shopify reconcile: order persist failed', {
        level: 'warning',
        tags: { route: 'cron.shopify-reconcile' },
        extra: {
          shopId: shop.id,
          shopDomain: shop.shop_domain,
          shopifyOrderGid: node.id,
          shopifyOrderUpdatedAt: node.updatedAt ?? null,
          error: result.error,
        },
      });
    }
  }

  const cursorAfter = computeNextReconcileCursor(cursorBefore, runStartedAt, outcomes);
  if (cursorAfter) {
    await admin.from('shop').update({ last_reconciled_at: cursorAfter }).eq('id', shop.id);
  }

  return { syncedCount, failedCount, examinedCount: nodes.length, cursorBefore, cursorAfter };
}

async function persistBulkOrders(
  admin: AdminClient,
  shop: ShopRow,
  operation: BulkOperation,
  runStartedAt: string,
): Promise<PersistOutcome> {
  const cursorBefore = shop.last_reconciled_at;

  // objectCount 0 → url null (aucune commande modifiée) : rien à examiner, le curseur peut
  // avancer en sécurité jusqu'à `runStartedAt`.
  if (!operation.url) {
    return persistBulkOrderNodes(admin, shop, [], runStartedAt);
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
    // L'audit lui-même a échoué avant toute persistance : aucune commande de ce lot n'a été
    // traitée, le curseur ne bouge pas (on ne sait rien sur ces commandes).
    return {
      syncedCount: 0,
      failedCount: nodes.length,
      examinedCount: nodes.length,
      cursorBefore,
      cursorAfter: cursorBefore,
    };
  }

  return persistBulkOrderNodes(admin, shop, nodes, runStartedAt);
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

  // Capturé AVANT le lancement de la bulk operation : borne sûre pour le prochain curseur en cas
  // de succès complet (voir `computeNextReconcileCursor`).
  const runStartedAt = new Date().toISOString();

  try {
    await startBulkOrdersOperation(shop.shop_domain, token.accessToken, shop.last_reconciled_at);
    const operation = await waitForBulkCompletion(shop.shop_domain, token.accessToken);
    if (operation.status !== 'COMPLETED') {
      // Bulk operation en échec avant toute persistance : le curseur reste inchangé (on ne le
      // touche tout simplement pas).
      return { ok: false, reason: 'bulk_failed' };
    }
    const outcome = await persistBulkOrders(admin, shop, operation, runStartedAt);
    return { ok: true, ...outcome };
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

  const runStartedAt = new Date().toISOString();

  try {
    const operation = await pollBulkOperation(shop.shop_domain, token.accessToken);
    if (!operation || operation.status !== 'COMPLETED') {
      return { ok: false, reason: 'bulk_failed' };
    }
    const outcome = await persistBulkOrders(admin, shop, operation, runStartedAt);
    return { ok: true, ...outcome };
  } catch {
    return { ok: false, reason: 'bulk_failed' };
  }
}
