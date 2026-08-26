// Phase 2 / Lot L2 — orchestration de la double écriture pour les webhooks Shopify.
//
// Couche applicative : résout la connexion (avec recoupement d'app), écrit ingestion_event, lie
// external_ref pour les ressources qui en ont une (order, product — jamais refund/bulk finish),
// pose orders.store_connection_id. TOUJOURS best-effort : n'importe quelle erreur ici est absorbée
// par l'appelant (route.ts), jamais laissée remonter et casser le chemin webhook_event legacy qui
// reste autoritatif en lecture dans ce lot. Best-effort ne veut PAS dire silencieux : toute écriture
// refusée pour une raison AUTRE que le rejeu attendu (dédoublonnage, collision) part vers Sentry —
// sinon un défaut de permission/schéma sur ingestion_event/external_ref resterait invisible.
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
import { getShopifyAppForShop } from '@/lib/shopify/apps';
import type { Database } from '@/lib/supabase/database.types';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

type ShopForDualWrite = {
  id: string;
  merchant_account_id: string;
  shop_domain: string;
  shopify_client_id: string | null;
};

function reportDualWriteFailure(
  step: 'write_ingestion_event' | 'link_external_ref' | 'set_order_store_connection',
  error: string,
  extra: Record<string, unknown>,
) {
  Sentry.captureException(new Error(`shopify_dual_write_${step}_failed`), {
    tags: { module: 'ingestion.shopify-dual-write' },
    extra: { error, ...extra },
  });
}

// Résout la store_connection pour cette boutique, avec recoupement d'app. `null` si la connexion
// est inconnue ou si l'app ne correspond pas — refus SILENCIEUX (pas d'exception Sentry) : ce cas
// est structurellement fréquent tant que toutes les boutiques n'ont pas de store_connection
// résolvable (comportement voulu, cf. rapport de session), pas un signal d'incident.
//
// Exportée (Lot idempotence refund) : app/api/shopify/webhooks/route.ts la réutilise pour obtenir
// le store_connection_id nécessaire à record_shopify_refund_receipt, plutôt que de dupliquer cette
// résolution.
export async function resolveShopConnection(
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

// ── Cœur ctx-based, réutilisé par le legacy (shop → ctx via domaine) et par le nouvel endpoint à
// jeton opaque (Lot L3, ctx déjà résolu par lib/ingestion/resolve-connection.ts). Extraire ce cœur
// évite de dupliquer la logique d'écriture entre les deux points d'entrée — un seul endroit sait
// écrire ingestion_event/external_ref pour une ressource donnée, quelle que soit la façon dont ctx
// a été obtenu.
export async function writeOrderIngestion(
  supabase: AdminClient,
  ctx: ResolvedConnectionContext,
  {
    topic,
    orderNode,
    deliveryId,
    triggeredAt,
  }: {
    topic: string;
    orderNode: { id: string };
    deliveryId: string | null;
    triggeredAt: string | null;
  },
): Promise<void> {
  const envelope = normalizeShopifyOrder(orderNode);

  const ingestionResult = await writeIngestionEvent(supabase, {
    ctx,
    topic,
    deliveryId,
    resourceKind: envelope.kind,
    resourceExternalId: envelope.externalOrderId,
    status: 'done',
    triggeredAt,
  });
  if (!ingestionResult.ok) {
    reportDualWriteFailure('write_ingestion_event', ingestionResult.error, {
      topic,
      deliveryId,
      storeConnectionId: ctx.storeConnectionId,
    });
  }

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

  const refResult = await linkExternalRef(supabase, {
    ctx,
    entityType: 'order',
    externalId: envelope.externalOrderId,
    entityId: order.id,
  });
  if (!refResult.ok) {
    reportDualWriteFailure('link_external_ref', refResult.error, {
      entityType: 'order',
      externalId: envelope.externalOrderId,
      entityId: order.id,
      storeConnectionId: ctx.storeConnectionId,
    });
  }

  const connectionResult = await setOrderStoreConnectionIfMissing(supabase, {
    ctx,
    orderId: order.id,
  });
  if (!connectionResult.ok) {
    reportDualWriteFailure('set_order_store_connection', connectionResult.error, {
      orderId: order.id,
      storeConnectionId: ctx.storeConnectionId,
    });
  }
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
  await writeOrderIngestion(supabase, ctx, { topic, orderNode, deliveryId, triggeredAt });
}

export async function writeProductIngestion(
  supabase: AdminClient,
  ctx: ResolvedConnectionContext,
  {
    topic,
    productNode,
    deliveryId,
    triggeredAt,
  }: {
    topic: string;
    productNode: { id: string; variants: { edges: Array<{ node: { id: string } }> } };
    deliveryId: string | null;
    triggeredAt: string | null;
  },
): Promise<void> {
  const envelope = normalizeShopifyProduct(productNode);

  const ingestionResult = await writeIngestionEvent(supabase, {
    ctx,
    topic,
    deliveryId,
    resourceKind: envelope.kind,
    resourceExternalId: envelope.externalProductId,
    status: 'done',
    triggeredAt,
  });
  if (!ingestionResult.ok) {
    reportDualWriteFailure('write_ingestion_event', ingestionResult.error, {
      topic,
      deliveryId,
      storeConnectionId: ctx.storeConnectionId,
    });
  }

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

    const refResult = await linkExternalRef(supabase, {
      ctx,
      entityType: 'product',
      externalId: variantExternalId,
      entityId: productRow.id,
    });
    if (!refResult.ok) {
      reportDualWriteFailure('link_external_ref', refResult.error, {
        entityType: 'product',
        externalId: variantExternalId,
        entityId: productRow.id,
        storeConnectionId: ctx.storeConnectionId,
      });
    }
  }
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
  await writeProductIngestion(supabase, ctx, { topic, productNode, deliveryId, triggeredAt });
}

export async function writeRefundIngestion(
  supabase: AdminClient,
  ctx: ResolvedConnectionContext,
  {
    topic,
    orderId,
    deliveryId,
    triggeredAt,
  }: {
    topic: string;
    orderId: string | null;
    deliveryId: string | null;
    triggeredAt: string | null;
  },
): Promise<void> {
  const envelope = normalizeShopifyRefund({ orderId });

  const ingestionResult = await writeIngestionEvent(supabase, {
    ctx,
    topic,
    deliveryId,
    resourceKind: envelope?.kind ?? null,
    resourceExternalId: envelope?.externalOrderId ?? null,
    status: 'done',
    triggeredAt,
  });
  if (!ingestionResult.ok) {
    reportDualWriteFailure('write_ingestion_event', ingestionResult.error, {
      topic,
      deliveryId,
      storeConnectionId: ctx.storeConnectionId,
    });
  }
  // Pas d'external_ref pour 'refund' — cf. CanonicalRefund (lib/ingestion/canonical.ts).
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
  await writeRefundIngestion(supabase, ctx, { topic, orderId, deliveryId, triggeredAt });
}

export async function writeBulkOperationIngestion(
  supabase: AdminClient,
  ctx: ResolvedConnectionContext,
  {
    topic,
    deliveryId,
    triggeredAt,
  }: {
    topic: string;
    deliveryId: string | null;
    triggeredAt: string | null;
  },
): Promise<void> {
  const ingestionResult = await writeIngestionEvent(supabase, {
    ctx,
    topic,
    deliveryId,
    resourceKind: 'bulk_operation_finished',
    resourceExternalId: null,
    status: 'done',
    triggeredAt,
  });
  if (!ingestionResult.ok) {
    reportDualWriteFailure('write_ingestion_event', ingestionResult.error, {
      topic,
      deliveryId,
      storeConnectionId: ctx.storeConnectionId,
    });
  }
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
  await writeBulkOperationIngestion(supabase, ctx, { topic, deliveryId, triggeredAt });
}
