import type { ResolvedConnectionContext, VerifiedWebhook } from '@/lib/ingestion/canonical';
import {
  linkExternalRef,
  setOrderStoreConnectionIfMissing,
  writeIngestionEvent,
} from '@/lib/ingestion/dual-write';
import { resolveConnectionForWebhook } from '@/lib/ingestion/resolve-connection';
import {
  normalizeShopifyOrder,
  normalizeShopifyProduct,
  normalizeShopifyRefund,
} from '@/lib/shopify/adapter';
// Phase 2 / Lot L2 — orchestration de la double écriture pour les webhooks Shopify.
//
// Couche applicative : résout la connexion (avec recoupement d'app), écrit ingestion_event, lie
// external_ref pour les ressources qui en ont une (order, product — jamais refund/bulk finish),
// pose orders.store_connection_id. TOUJOURS best-effort : n'importe quelle erreur ici est absorbée
// par l'appelant (route.ts), jamais laissée remonter et casser le chemin webhook_event legacy qui
// reste autoritatif en lecture dans ce lot.
import { getShopifyAppForShop } from '@/lib/shopify/apps';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

type ShopForDualWrite = {
  id: string;
  merchant_account_id: string;
  shop_domain: string;
  shopify_client_id: string | null;
};

// Résout la store_connection pour cette boutique, avec recoupement d'app. `null` si la connexion
// est inconnue ou si l'app ne correspond pas — refus silencieux au niveau de la double écriture
// (le chemin legacy, lui, n'est jamais bloqué par ce lot).
async function resolveShopConnection(
  supabase: AdminClient,
  shop: ShopForDualWrite,
): Promise<ResolvedConnectionContext | null> {
  const app = getShopifyAppForShop(shop.shopify_client_id);
  if (!app) {
    return null;
  }
  const verified: VerifiedWebhook = {
    platformAppId: app.clientId,
    externalConnectionId: shop.shop_domain,
    payload: null,
  };
  const resolved = await resolveConnectionForWebhook(supabase, verified, { platform: 'shopify' });
  return resolved.ok ? resolved.context : null;
}

export async function dualWriteOrderWebhook({
  supabase,
  shop,
  topic,
  orderNode,
  deliveryId,
  triggeredAt,
}: {
  supabase: AdminClient;
  shop: ShopForDualWrite;
  topic: string;
  orderNode: { id: string };
  deliveryId: string | null;
  triggeredAt: string | null;
}): Promise<void> {
  const ctx = await resolveShopConnection(supabase, shop);
  if (!ctx) {
    return;
  }

  const envelope = normalizeShopifyOrder(orderNode);

  await writeIngestionEvent(supabase, {
    ctx,
    topic,
    deliveryId,
    resourceKind: envelope.kind,
    resourceExternalId: envelope.externalOrderId,
    status: 'done',
    triggeredAt,
  });

  const { data: order } = await supabase
    .from('orders')
    .select('id')
    .eq('merchant_account_id', ctx.merchantAccountId)
    .eq('shop_id', ctx.shopId)
    .eq('shopify_order_id', envelope.externalOrderId)
    .maybeSingle();

  if (!order) {
    return;
  }

  await linkExternalRef(supabase, {
    ctx,
    entityType: 'order',
    externalId: envelope.externalOrderId,
    entityId: order.id,
  });
  await setOrderStoreConnectionIfMissing(supabase, { ctx, orderId: order.id });
}

export async function dualWriteProductWebhook({
  supabase,
  shop,
  topic,
  productNode,
  deliveryId,
  triggeredAt,
}: {
  supabase: AdminClient;
  shop: ShopForDualWrite;
  topic: string;
  productNode: { id: string; variants: { edges: Array<{ node: { id: string } }> } };
  deliveryId: string | null;
  triggeredAt: string | null;
}): Promise<void> {
  const ctx = await resolveShopConnection(supabase, shop);
  if (!ctx) {
    return;
  }

  const envelope = normalizeShopifyProduct(productNode);

  await writeIngestionEvent(supabase, {
    ctx,
    topic,
    deliveryId,
    resourceKind: envelope.kind,
    resourceExternalId: envelope.externalProductId,
    status: 'done',
    triggeredAt,
  });

  // external_ref pour 'product' est backfillée sur shopify_variant_id (0142) — jamais l'id produit
  // Shopify, qui n'identifie pas une ligne de `product` (une variante par ligne). On lie donc
  // chaque variante du webhook séparément.
  for (const edge of productNode.variants.edges) {
    const variantExternalId = edge.node.id;
    if (!variantExternalId) {
      continue;
    }
    const { data: productRow } = await supabase
      .from('product')
      .select('id')
      .eq('merchant_account_id', ctx.merchantAccountId)
      .eq('shop_id', ctx.shopId)
      .eq('shopify_variant_id', variantExternalId)
      .maybeSingle();

    if (!productRow) {
      continue;
    }

    await linkExternalRef(supabase, {
      ctx,
      entityType: 'product',
      externalId: variantExternalId,
      entityId: productRow.id,
    });
  }
}

export async function dualWriteRefundWebhook({
  supabase,
  shop,
  topic,
  orderId,
  deliveryId,
  triggeredAt,
}: {
  supabase: AdminClient;
  shop: ShopForDualWrite;
  topic: string;
  orderId: string | null;
  deliveryId: string | null;
  triggeredAt: string | null;
}): Promise<void> {
  const ctx = await resolveShopConnection(supabase, shop);
  if (!ctx) {
    return;
  }

  const envelope = normalizeShopifyRefund({ orderId });

  await writeIngestionEvent(supabase, {
    ctx,
    topic,
    deliveryId,
    resourceKind: envelope?.kind ?? null,
    resourceExternalId: envelope?.externalOrderId ?? null,
    status: 'done',
    triggeredAt,
  });
  // Pas d'external_ref pour 'refund' — cf. CanonicalRefund (lib/ingestion/canonical.ts).
}

export async function dualWriteBulkOperationFinishedWebhook({
  supabase,
  shop,
  topic,
  deliveryId,
  triggeredAt,
}: {
  supabase: AdminClient;
  shop: ShopForDualWrite;
  topic: string;
  deliveryId: string | null;
  triggeredAt: string | null;
}): Promise<void> {
  const ctx = await resolveShopConnection(supabase, shop);
  if (!ctx) {
    return;
  }

  await writeIngestionEvent(supabase, {
    ctx,
    topic,
    deliveryId,
    resourceKind: 'bulk_operation_finished',
    resourceExternalId: null,
    status: 'done',
    triggeredAt,
  });
}
