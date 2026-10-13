// Reprise interne des webhooks Shopify : QUI est repris, et quand. Module pur.
//
// Pourquoi une reprise interne : les deux points d'entrée répondent 200 à Shopify même quand le
// traitement échoue (l'un traite après la réponse, l'autre avant, tous deux rendent 200). Un
// événement resté `retryable`, ou `processing` après la mort de son exécution, n'était repris
// que par une NOUVELLE livraison du même identifiant — que Shopify ne fait pas après un 200.
//
// Ce module ne décide que de l'éligibilité. La réclamation reste celle de la base
// (`claim_shopify_webhook_events`, verrou de ligne et bail), seule à départager deux exécutions.

import { WEBHOOK_LEASE_MS } from '@/lib/shopify/webhook-retry';

export const GDPR_REPLAY_TOPICS = [
  'customers/data_request',
  'customers/redact',
  'shop/redact',
] as const;

export const ORDER_REPLAY_TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'orders/fulfilled',
] as const;

// Sujets repris. Les autres restent en l'état et sont COMPTÉS, jamais repris :
//   * `app/uninstalled` exige l'app dont le HMAC a été validé, que `webhook_event` ne garde pas ;
//   * `products/*`, `refunds/create`, `bulk_operations/finish` : hors de ce lot.
export const REPLAY_TOPICS: readonly string[] = [...GDPR_REPLAY_TOPICS, ...ORDER_REPLAY_TOPICS];

// `attempt_count` compte la tentative de la livraison (1) puis chaque réclamation. À 6, cinq
// reprises ont échoué : l'événement n'est plus repris, il est signalé.
export const WEBHOOK_REPLAY_MAX_ATTEMPTS = 6;

// Au-delà, un événement n'est plus repris automatiquement. Rejouer seul une suppression RGPD ou
// une mise à jour de commande vieille de plusieurs semaines demande un regard humain.
export const WEBHOOK_REPLAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

// Marge d'horloge entre l'application et la base. La reprise réclame « comme s'il était une
// minute plus tôt » : un bail n'est tenu pour expiré qu'une minute après son échéance.
export const WEBHOOK_REPLAY_CLOCK_MARGIN_MS = 60 * 1_000;

// Durée maximale de l'exécution planifiée, et temps au-delà duquel elle ne réclame plus rien.
// Invariant de non-recouvrement : une exécution meurt AVANT l'expiration du bail de ce qu'elle a
// réclamé. Bail posé à la réclamation = 5 min − marge = 4 min ; exécution = 3 min au plus.
export const WEBHOOK_REPLAY_MAX_DURATION_S = 180;
export const WEBHOOK_REPLAY_BUDGET_MS = 150 * 1_000;
// Plafond de lecture de PostgREST (`max_rows`) : au-delà, le relevé le dit (`scanTruncated`).
export const WEBHOOK_REPLAY_SCAN_LIMIT = 1000;

export function replayNonOverlapHolds(): boolean {
  return WEBHOOK_REPLAY_MAX_DURATION_S * 1_000 < WEBHOOK_LEASE_MS - WEBHOOK_REPLAY_CLOCK_MARGIN_MS;
}

export type ReplayCandidate = {
  attempt_count: number;
  lease_until: string | null;
  next_attempt_at: string | null;
  received_at: string;
  status: string;
  topic: string;
};

export type ReplayDecision =
  | 'eligible'
  | 'unsupported_topic'
  | 'too_old'
  | 'exhausted'
  | 'not_due'
  | 'leased'
  | 'not_pending';

/** L'instant présenté à la base pour réclamer : maintenant, moins la marge d'horloge. */
export function replayClaimInstant(now: Date): Date {
  return new Date(now.getTime() - WEBHOOK_REPLAY_CLOCK_MARGIN_MS);
}

export function classifyReplayCandidate(candidate: ReplayCandidate, now: Date): ReplayDecision {
  if (candidate.status !== 'retryable' && candidate.status !== 'processing') {
    return 'not_pending';
  }
  if (!REPLAY_TOPICS.includes(candidate.topic)) {
    return 'unsupported_topic';
  }
  if (Date.parse(candidate.received_at) < now.getTime() - WEBHOOK_REPLAY_WINDOW_MS) {
    return 'too_old';
  }
  if (candidate.attempt_count >= WEBHOOK_REPLAY_MAX_ATTEMPTS) {
    return 'exhausted';
  }
  const claimInstant = replayClaimInstant(now).getTime();
  if (candidate.status === 'retryable') {
    // Même prédicat que la base : une échéance absente n'est jamais due.
    return candidate.next_attempt_at !== null &&
      Date.parse(candidate.next_attempt_at) <= claimInstant
      ? 'eligible'
      : 'not_due';
  }
  return candidate.lease_until === null || Date.parse(candidate.lease_until) < claimInstant
    ? 'eligible'
    : 'leased';
}

export function isGdprReplayTopic(topic: string): boolean {
  return (GDPR_REPLAY_TOPICS as readonly string[]).includes(topic);
}
