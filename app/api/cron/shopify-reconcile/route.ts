// Réconciliation nocturne Shopify (Phase 7a) : re-pull bulk par boutique active, rattrape les
// webhooks ratés. Idempotent (upsert par (shop_id, shopify_order_id), garde hors-ordre).

import { getShopifyAppForShop } from '@/lib/shopify/apps';
import { reconcileShopOrders } from '@/lib/shopify/reconcile';
import type { Database, Tables } from '@/lib/supabase/database.types';
import * as Sentry from '@sentry/nextjs';
import { createClient } from '@supabase/supabase-js';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type ShopRow = Tables<'shop'>;

export async function GET(request: NextRequest) {
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

  const supabase = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: shops, error } = await supabase.from('shop').select('*').eq('status', 'active');

  if (error) {
    Sentry.captureException(error, { tags: { route: 'cron.shopify-reconcile' } });
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const results: Array<{ shopId: string; ok: boolean; detail: string }> = [];
  for (const shop of (shops ?? []) as ShopRow[]) {
    // Multi-app : credentials de l'app ayant installé cette boutique (fallback app par défaut).
    const app = getShopifyAppForShop(shop.shopify_client_id);
    if (!app) {
      results.push({ shopId: shop.id, ok: false, detail: 'no_shopify_app' });
      continue;
    }
    const result = await reconcileShopOrders(supabase, shop, app.clientId, app.clientSecret);
    results.push({
      shopId: shop.id,
      ok: result.ok,
      detail: result.ok
        ? `synced=${result.syncedCount} failed=${result.failedCount}`
        : result.reason,
    });
    if (!result.ok) {
      Sentry.captureMessage('Shopify reconcile failed for shop', {
        level: 'warning',
        tags: { route: 'cron.shopify-reconcile' },
        extra: { shopId: shop.id, reason: result.reason },
      });
    }
  }

  return NextResponse.json({ ok: true, shops: results, timestamp: new Date().toISOString() });
}
