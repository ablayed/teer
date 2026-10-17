// Reprise interne des webhooks Shopify restés `retryable`, ou `processing` après la mort de leur
// exécution. Appelée par le cron `shopify-webhook-retry` ; aucune nouvelle livraison de Shopify
// n'est nécessaire. Politique d'éligibilité : lib/shopify/webhook-replay-policy.ts.
//
// Sans double traitement, par trois moyens :
//   1. chaque événement est réclamé UN PAR UN par `claim_shopify_webhook_events` (verrou de ligne,
//      `skip locked`, bail de cinq minutes) : deux exécutions ne réclament jamais le même ;
//   2. l'exécution s'arrête de réclamer bien avant sa propre échéance, elle-même plus courte que
//      le bail : elle est morte avant qu'un autre puisse reprendre ce qu'elle tenait ;
//   3. le traitement repris est celui des points d'entrée (`runResolvedWebhookEvent`), idempotent
//      par sujet : une charge déjà appliquée est écartée sans écriture.
//
// Identité : la reprise ne décide rien de nouveau. Elle relit ce que la réception a enregistré
// APRÈS la vérification du HMAC — la charge signée, le domaine et la boutique résolus — et refait
// la même résolution que le point d'entrée : domaine du corps signé pour les sujets RGPD (D20a),
// boutique enregistrée pour les commandes.

import { resolveGdprShopDomain } from '@/lib/shopify/gdpr-shop-domain';
import type { WebhookShopLocator } from '@/lib/shopify/webhook-core';
import {
  finishWebhookStatus,
  isTerminalWebhookError,
  resolveShopForTopic,
  resolveShopLenient,
  runResolvedWebhookEvent,
} from '@/lib/shopify/webhook-core';
import {
  type ReplayCandidate,
  type ReplayDecision,
  WEBHOOK_REPLAY_BUDGET_MS,
  WEBHOOK_REPLAY_SCAN_LIMIT,
  classifyReplayCandidate,
  isGdprReplayTopic,
  replayClaimInstant,
  replayEligibilityFilter,
  replayReviewFilter,
} from '@/lib/shopify/webhook-replay-policy';
import type { Database } from '@/lib/supabase/database.types';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

type CandidateRow = ReplayCandidate & {
  id: string;
  shop_domain: string | null;
  shop_id: string | null;
  shopify_webhook_id: string;
  triggered_at: string | null;
};

const CANDIDATE_COLUMNS =
  'id, topic, status, attempt_count, received_at, next_attempt_at, lease_until, shop_id, shop_domain, shopify_webhook_id, triggered_at';

export type WebhookReplaySummary = {
  // Candidats ÉLIGIBLES lus, filtrés en base (au plus WEBHOOK_REPLAY_SCAN_LIMIT, les plus anciens).
  examined: number;
  scanTruncated: boolean;
  // Issue des événements repris par cette exécution.
  replayed: { done: number; retryable: number; terminal: number; unknown: number };
  // Non repris, par motif. `needsReview` : ceux qui demandent un regard humain.
  skipped: Record<Exclude<ReplayDecision, 'eligible' | 'not_pending'>, number> & {
    notClaimed: number;
    payloadUnavailable: number;
    shopRedactOnActiveShop: number;
  };
  // Par sujet : événements laissés en l'état parce que trop anciens, épuisés ou non pris en charge.
  needsReview: Record<string, number>;
  stoppedOnBudget: boolean;
};

function emptySummary(): WebhookReplaySummary {
  return {
    examined: 0,
    needsReview: {},
    replayed: { done: 0, retryable: 0, terminal: 0, unknown: 0 },
    scanTruncated: false,
    skipped: {
      exhausted: 0,
      leased: 0,
      notClaimed: 0,
      not_due: 0,
      payloadUnavailable: 0,
      shopRedactOnActiveShop: 0,
      too_old: 0,
      unsupported_topic: 0,
    },
    stoppedOnBudget: false,
  };
}

function logReplay(message: string, details: Record<string, unknown>) {
  // biome-ignore lint/suspicious/noConsole: journal opérationnel du pipeline webhook.
  console.error(message, details);
}

function shopLocator(row: {
  shop_domain: string | null;
  shop_id: string | null;
}): WebhookShopLocator | null {
  if (row.shop_id) return { by: 'id', shopId: row.shop_id };
  if (row.shop_domain) return { by: 'domain', shopDomain: row.shop_domain };
  return null;
}

// Une suppression de boutique reprise APRÈS coup ne s'exécute jamais seule sur une boutique
// redevenue active : entre l'échec et la reprise, le marchand a pu réinstaller, et la suppression
// effacerait ses données courantes. Elle est laissée en l'état et signalée.
async function isShopRedactOnActiveShop(admin: AdminClient, row: CandidateRow): Promise<boolean> {
  if (row.topic !== 'shop/redact') return false;
  const locator = shopLocator(row);
  if (!locator) return false;
  const shop = await resolveShopLenient(admin, locator);
  return shop?.status === 'active';
}

async function replayClaimedEvent(
  admin: AdminClient,
  row: CandidateRow,
  event: { payload: unknown; shop_domain: string | null; shop_id: string | null; topic: string },
): Promise<void> {
  const common = {
    eventId: row.id,
    payload: event.payload,
    supabase: admin,
    topic: event.topic,
    triggeredAt: row.triggered_at,
    // Aucun sujet repris ne consomme l'app validante ; `app/uninstalled`, qui l'exige, n'est pas repris.
    validatedClientId: null,
    webhookId: row.shopify_webhook_id,
  };

  if (isGdprReplayTopic(event.topic)) {
    // D20a, comme le point d'entrée historique (app/api/shopify/webhooks/route.ts) : le domaine
    // du corps SIGNÉ fait autorité, celui enregistré à la réception doit lui être strictement
    // égal. Rejet avant toute résolution de boutique, toute lecture et toute suppression.
    const gdpr = resolveGdprShopDomain(event.shop_domain, event.payload);
    if (!gdpr.ok) {
      const errorCode = `gdpr_shop_domain_${gdpr.reason}`;
      await finishWebhookStatus({
        errorCode,
        eventId: row.id,
        outcome: isTerminalWebhookError(new Error(errorCode)) ? 'terminal' : 'retryable',
        supabase: admin,
      });
      return;
    }
    const shop = await resolveShopForTopic(admin, event.topic, {
      by: 'domain',
      shopDomain: gdpr.shopDomain,
    });
    await runResolvedWebhookEvent({ ...common, resolvedShopDomain: gdpr.shopDomain, shop });
    return;
  }

  const shop = await resolveShopForTopic(admin, event.topic, shopLocator(event));
  await runResolvedWebhookEvent({ ...common, resolvedShopDomain: event.shop_domain, shop });
}

async function countEventsNeedingReview(
  admin: AdminClient,
  now: Date,
  scanLimit: number,
  summary: WebhookReplaySummary,
): Promise<void> {
  const { data, error } = await admin
    .from('webhook_event')
    .select('topic, status, attempt_count, received_at, next_attempt_at, lease_until')
    .in('status', ['retryable', 'processing'])
    .or(replayReviewFilter(now))
    .order('received_at', { ascending: false })
    .limit(scanLimit);
  if (error) {
    // Le décompte est un relevé, pas une condition de la reprise : il ne l'empêche pas.
    logReplay('[webhook-replay] review count failed', { code: error.code });
    return;
  }
  for (const row of (data ?? []) as ReplayCandidate[]) {
    const decision = classifyReplayCandidate(row, now);
    if (decision === 'too_old' || decision === 'exhausted' || decision === 'unsupported_topic') {
      summary.skipped[decision] += 1;
      summary.needsReview[row.topic] = (summary.needsReview[row.topic] ?? 0) + 1;
    }
  }
}

export async function replayPendingShopifyWebhooks(
  admin: AdminClient,
  {
    now = new Date(),
    budgetMs = WEBHOOK_REPLAY_BUDGET_MS,
    scanLimit = WEBHOOK_REPLAY_SCAN_LIMIT,
    reportReview = true,
  }: { now?: Date; budgetMs?: number; scanLimit?: number; reportReview?: boolean } = {},
): Promise<WebhookReplaySummary> {
  const startedAt = Date.now();
  const summary = emptySummary();

  // Le filtre d'éligibilité s'applique EN BASE, avant la limite : des événements non éligibles,
  // même plus récents et plus nombreux que la limite, ne masquent jamais un éligible plus ancien.
  // Les plus anciens d'abord : l'ordre de réception (la création d'une commande avant sa mise à
  // jour) tient aussi quand la lecture est tronquée, et un événement qui échoue sort de la
  // sélection au plafond de tentatives.
  const eligible = replayEligibilityFilter(now);
  const { data, error } = await admin
    .from('webhook_event')
    .select(CANDIDATE_COLUMNS)
    .in('status', [...eligible.statuses])
    .in('topic', [...eligible.topics])
    .gte('received_at', eligible.receivedFrom)
    .lt('attempt_count', eligible.attemptsBelow)
    .or(eligible.dueOrExpired)
    .order('received_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(scanLimit);
  if (error) {
    throw new Error('shopify_webhook_replay_scan_failed');
  }

  const rows = (data ?? []) as CandidateRow[];
  summary.examined = rows.length;
  summary.scanTruncated = rows.length >= scanLimit;
  const claimInstant = replayClaimInstant(now).toISOString();

  // Les événements en attente que la reprise ne prend pas (sujet non repris, hors fenêtre,
  // tentatives épuisées) sont comptés à part : ils demandent un regard humain, jamais un rejeu.
  // Le balayage opportuniste d'une livraison n'a pas à refaire ce relevé : il appartient au cron.
  if (reportReview) {
    await countEventsNeedingReview(admin, now, scanLimit, summary);
  }

  for (const row of rows) {
    const decision = classifyReplayCandidate(row, now);
    if (decision === 'not_pending') continue;
    if (decision !== 'eligible') {
      // Seconde garde : le filtre de la base ne laisse passer que des éligibles, sauf si l'état a
      // changé entre la lecture et ici.
      summary.skipped[decision] += 1;
      continue;
    }

    if (Date.now() - startedAt > budgetMs) {
      summary.stoppedOnBudget = true;
      break;
    }

    if (await isShopRedactOnActiveShop(admin, row)) {
      summary.skipped.shopRedactOnActiveShop += 1;
      summary.needsReview[row.topic] = (summary.needsReview[row.topic] ?? 0) + 1;
      continue;
    }

    const claim = await admin.rpc('claim_shopify_webhook_events', {
      p_event_id: row.id,
      p_limit: 1,
      p_now: claimInstant,
    });
    const event = claim.data?.[0];
    if (claim.error || !event) {
      // Réclamé par une autre exécution, ou état changé depuis la lecture : rien à faire.
      summary.skipped.notClaimed += 1;
      if (claim.error) logReplay('[webhook-replay] claim failed', { code: claim.error.code });
      continue;
    }

    if (event.payload === null) {
      // Sans charge, rien ne peut plus être traité. L'événement est clos, et le dit.
      await finishWebhookStatus({
        errorCode: 'webhook_payload_unavailable',
        eventId: row.id,
        outcome: 'terminal',
        supabase: admin,
      });
      summary.skipped.payloadUnavailable += 1;
      summary.needsReview[row.topic] = (summary.needsReview[row.topic] ?? 0) + 1;
      continue;
    }

    await replayClaimedEvent(admin, row, event);

    const { data: after } = await admin
      .from('webhook_event')
      .select('status')
      .eq('id', row.id)
      .maybeSingle();
    const outcome = after?.status;
    if (outcome === 'done' || outcome === 'retryable' || outcome === 'terminal') {
      summary.replayed[outcome] += 1;
    } else {
      summary.replayed.unknown += 1;
    }
  }

  const reviewCount = Object.values(summary.needsReview).reduce((total, n) => total + n, 0);
  if (reviewCount > 0 || summary.replayed.terminal > 0) {
    logReplay('[webhook-replay] events need review', {
      needsReview: summary.needsReview,
      skipped: summary.skipped,
    });
    // Des comptes seulement : aucun identifiant, aucun domaine, aucune charge.
    Sentry.captureMessage('shopify_webhook_replay_needs_review', {
      extra: {
        needsReview: summary.needsReview,
        replayed: summary.replayed,
        skipped: summary.skipped,
      },
      level: 'warning',
      tags: { module: 'shopify.webhook-replay' },
    });
  }

  return summary;
}
