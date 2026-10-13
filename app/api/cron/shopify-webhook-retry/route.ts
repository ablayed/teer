// Reprise interne des webhooks Shopify (lib/shopify/webhook-replay.ts).
//
// Les points d'entrée répondent 200 à Shopify même quand le traitement échoue ; Shopify ne
// relivre donc pas. Ce cron reprend les événements restés `retryable`, ou `processing` après la
// mort de leur exécution, sans attendre de nouvelle livraison. Sujets repris, plafond de
// tentatives, fenêtre et marge d'horloge : lib/shopify/webhook-replay-policy.ts.
//
// La réponse ne porte que des comptes : aucun identifiant, aucun domaine, aucune charge.

import { replayPendingShopifyWebhooks } from '@/lib/shopify/webhook-replay';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import * as Sentry from '@sentry/nextjs';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Plus court que le bail d'un événement réclamé : voir `replayNonOverlapHolds`
// (lib/shopify/webhook-replay-policy.ts). Next exige ici un littéral.
export const maxDuration = 180;

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

  const supabase = createProtectedSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const summary = await replayPendingShopifyWebhooks(supabase);
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    Sentry.captureException(error, { tags: { route: 'cron.shopify-webhook-retry' } });
    return NextResponse.json({ error: 'replay_failed', ok: false }, { status: 500 });
  }
}
