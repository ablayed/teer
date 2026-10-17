// Balayage des webhooks Shopify en attente, déclenché par une planification Upstash QStash
// (toutes les 5 minutes). Même reprise que le cron quotidien `shopify-webhook-retry`
// (lib/shopify/webhook-replay.ts) : réclamation un par un, bail, plafond de tentatives, fenêtre
// d'âge, garde de récence. Le cron quotidien reste le secours.
//
// Authentification : la signature QStash est vérifiée sur le corps brut et l'URL attendue, AVANT
// toute construction d'un client service-role. La réponse ne porte que des comptes.

import { verifyQstashRequest } from '@/lib/shopify/qstash-signature';
import { replayPendingShopifyWebhooks } from '@/lib/shopify/webhook-replay';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Même durée que le cron : plus courte que le bail d'un événement réclamé
// (lib/shopify/webhook-replay-policy.ts). Next exige ici un littéral.
export const maxDuration = 180;

export async function POST(request: Request) {
  const rawBody = await request.text();

  const verification = await verifyQstashRequest({
    signature: request.headers.get('upstash-signature'),
    rawBody,
    expectedUrl: process.env.QSTASH_SWEEP_URL,
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
  });
  if (!verification.ok) {
    // Non configurée : on ne sait rien authentifier, on ne fait rien (503, pas 401 : c'est nous).
    return verification.reason === 'not_configured'
      ? NextResponse.json({ error: 'not_configured' }, { status: 503 })
      : NextResponse.json({ error: 'unauthorized' }, { status: 401 });
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
    Sentry.captureException(error, { tags: { route: 'internal.shopify-webhook-sweep' } });
    return NextResponse.json({ error: 'replay_failed', ok: false }, { status: 500 });
  }
}
