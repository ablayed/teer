// Balayage opportuniste des webhooks Shopify en attente, déclenché par une nouvelle livraison.
//
// Le cron `shopify-webhook-retry` ne passe qu'une fois par jour (plan Hobby). Une fois le 200
// envoyé, Shopify ne relivre plus : un traitement tué après l'accusé attendrait donc jusqu'à
// vingt-quatre heures. Chaque livraison reprend ici, après son propre traitement, les plus
// anciens événements éligibles, avec la MÊME logique que le cron (`replayPendingShopifyWebhooks` :
// réclamation un par un, bail, plafond de tentatives, garde d'ancienneté). Le cron reste le secours.

import { replayPendingShopifyWebhooks } from '@/lib/shopify/webhook-replay';
import type { Database } from '@/lib/supabase/database.types';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

// Un balayage par instance et par intervalle : un lot de livraisons simultanées ne multiplie pas
// les lectures d'éligibilité.
export const OPPORTUNISTIC_SWEEP_MIN_INTERVAL_MS = 30 * 1_000;
export const OPPORTUNISTIC_SWEEP_SCAN_LIMIT = 10;
// Bien en deçà du bail d'un événement réclamé (4 min) : l'invariant de non-recouvrement du cron
// vaut aussi ici.
export const OPPORTUNISTIC_SWEEP_BUDGET_MS = 30 * 1_000;

let lastSweepStartedAt = 0;

export function resetOpportunisticSweepThrottleForTests(): void {
  lastSweepStartedAt = 0;
}

export async function sweepPendingShopifyWebhooks(
  admin: SupabaseClient<Database>,
  nowMs: number = Date.now(),
): Promise<void> {
  if (nowMs - lastSweepStartedAt < OPPORTUNISTIC_SWEEP_MIN_INTERVAL_MS) {
    return;
  }
  lastSweepStartedAt = nowMs;

  try {
    await replayPendingShopifyWebhooks(admin, {
      budgetMs: OPPORTUNISTIC_SWEEP_BUDGET_MS,
      now: new Date(nowMs),
      reportReview: false,
      scanLimit: OPPORTUNISTIC_SWEEP_SCAN_LIMIT,
    });
  } catch (error) {
    Sentry.captureException(error, { tags: { route: 'shopify.webhook-opportunistic-sweep' } });
  }
}
