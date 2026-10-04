// Réconciliation nocturne Shopify (Phase 7a) : re-pull bulk par boutique active, rattrape les
// webhooks ratés. Idempotent (upsert par (shop_id, shopify_order_id), garde hors-ordre).
//
// SHOPIFY-WEBHOOKS-PER-SHOP-1B / G13 — pour chaque boutique, la réconciliation des ABONNEMENTS
// webhook passe AVANT celle des commandes, dans son propre try/catch : son échec ne prive jamais
// la boutique de la réconciliation des commandes. Le temps restant sur le budget du cron est
// contrôlé avant de lancer une boutique (lib/shopify/cron-budget.ts).

import { getShopifyAppForShop } from '@/lib/shopify/apps';
import { canStartShopReconcile } from '@/lib/shopify/cron-budget';
import { reconcileShopOrders } from '@/lib/shopify/reconcile';
import { readWebhookPublicBaseUrl } from '@/lib/shopify/webhook-base-url';
import { reconcileShopifyWebhookSubscriptions } from '@/lib/shopify/webhook-subscription-reconcile';
import type { Database, Tables } from '@/lib/supabase/database.types';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import * as Sentry from '@sentry/nextjs';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type ShopRow = Tables<'shop'>;

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const cronSecret = process.env.CRON_SECRET;
  const authorization = request.headers.get('authorization');

  if (!cronSecret || authorization !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: 'missing_env' }, { status: 500 });
  }

  const supabase = createProtectedSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: shops, error } = await supabase
    .from('shop')
    .select('*')
    .eq('store_kind', 'shopify')
    .eq('status', 'active');

  if (error) {
    Sentry.captureException(error, { tags: { route: 'cron.shopify-reconcile' } });
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  type ShopResult = {
    shopId: string;
    ok: boolean;
    detail: string;
    // Réconciliation des abonnements webhook : `ok`, ou la raison nommée de son échec.
    webhooks?: string;
    examinedCount?: number;
    syncedCount?: number;
    failedCount?: number;
    cursorBefore?: string | null;
    cursorAfter?: string | null;
  };

  const results: ShopResult[] = [];
  let anyDegraded = false;

  for (const shop of (shops ?? []) as ShopRow[]) {
    // Multi-app : credentials de l'app ayant installé cette boutique (fallback app par défaut).
    const app = getShopifyAppForShop(shop.shopify_client_id);
    if (!app) {
      results.push({ shopId: shop.id, ok: false, detail: 'no_shopify_app' });
      anyDegraded = true;
      continue;
    }

    // Temps restant insuffisant : la boutique est sautée et consignée, sans être lancée.
    if (!canStartShopReconcile(startedAt, Date.now())) {
      results.push({ shopId: shop.id, ok: false, detail: 'skipped_time_budget' });
      anyDegraded = true;
      Sentry.captureMessage('Shopify reconcile skipped for shop: time budget', {
        level: 'warning',
        tags: { route: 'cron.shopify-reconcile' },
        extra: { shopId: shop.id },
      });
      continue;
    }

    // Abonnements webhook d'abord, en mode réparation. Son propre try/catch : quoi qu'il arrive,
    // la réconciliation des commandes ci-dessous a lieu.
    let webhooks: string;
    try {
      const webhookResult = await reconcileShopifyWebhookSubscriptions(supabase, {
        shopId: shop.id,
        app: { clientId: app.clientId, clientSecret: app.clientSecret },
        mode: 'repair',
        webhookBaseUrl: readWebhookPublicBaseUrl(),
      });
      webhooks = webhookResult.ok ? 'ok' : webhookResult.reason;
    } catch {
      webhooks = 'exception';
    }
    if (webhooks !== 'ok') {
      anyDegraded = true;
    }

    const result = await reconcileShopOrders(supabase, shop, app.clientId, app.clientSecret);

    if (!result.ok) {
      results.push({ shopId: shop.id, ok: false, detail: result.reason, webhooks });
      anyDegraded = true;
      Sentry.captureMessage('Shopify reconcile failed for shop', {
        level: 'warning',
        tags: { route: 'cron.shopify-reconcile' },
        extra: { shopId: shop.id, reason: result.reason },
      });
      continue;
    }

    results.push({
      shopId: shop.id,
      ok: true,
      detail: `examined=${result.examinedCount} synced=${result.syncedCount} failed=${result.failedCount}`,
      webhooks,
      examinedCount: result.examinedCount,
      syncedCount: result.syncedCount,
      failedCount: result.failedCount,
      cursorBefore: result.cursorBefore,
      cursorAfter: result.cursorAfter,
    });

    // Un échec de persistance individuel n'empêche pas `result.ok` d'être vrai (le lot bulk a
    // globalement abouti) — mais il doit rester visible sans qu'on ait à chercher : le curseur
    // n'a pas avancé au-delà de cette commande (voir computeNextReconcileCursor), et un run
    // affecté ne doit jamais se distinguer d'un run propre uniquement par lecture du détail.
    if (result.failedCount > 0) {
      anyDegraded = true;
      Sentry.captureMessage('Shopify reconcile: shop run had order-level failures', {
        level: 'warning',
        tags: { route: 'cron.shopify-reconcile' },
        extra: {
          shopId: shop.id,
          shopDomain: shop.shop_domain,
          examinedCount: result.examinedCount,
          failedCount: result.failedCount,
          cursorBefore: result.cursorBefore,
          cursorAfter: result.cursorAfter,
        },
      });
    }
  }

  // 207 (Multi-Status) distingue un run avec au moins un échec (boutique ou commande) d'un run
  // propre — un code identique dans les deux cas serait lui-même un défaut d'observabilité.
  return NextResponse.json(
    {
      ok: true,
      status: anyDegraded ? 'degraded' : 'clean',
      shops: results,
      timestamp: new Date().toISOString(),
    },
    { status: anyDegraded ? 207 : 200 },
  );
}
