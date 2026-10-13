import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  REPLAY_TOPICS,
  type ReplayCandidate,
  WEBHOOK_REPLAY_BUDGET_MS,
  WEBHOOK_REPLAY_CLOCK_MARGIN_MS,
  WEBHOOK_REPLAY_MAX_ATTEMPTS,
  WEBHOOK_REPLAY_MAX_DURATION_S,
  WEBHOOK_REPLAY_WINDOW_MS,
  classifyReplayCandidate,
  replayClaimInstant,
  replayNonOverlapHolds,
} from '@/lib/shopify/webhook-replay-policy';
import { WEBHOOK_LEASE_MS } from '@/lib/shopify/webhook-retry';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const NOW = new Date('2026-10-13T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function candidate(patch: Partial<ReplayCandidate> = {}): ReplayCandidate {
  return {
    attempt_count: 1,
    lease_until: null,
    next_attempt_at: ago(10 * 60_000),
    received_at: ago(60 * 60_000),
    status: 'retryable',
    topic: 'customers/data_request',
    ...patch,
  };
}

describe('politique de reprise des webhooks', () => {
  it('reprend les sujets RGPD et les commandes, et eux seuls', () => {
    expect([...REPLAY_TOPICS].sort()).toEqual([
      'customers/data_request',
      'customers/redact',
      'orders/cancelled',
      'orders/create',
      'orders/fulfilled',
      'orders/updated',
      'shop/redact',
    ]);
    for (const topic of REPLAY_TOPICS) {
      expect(classifyReplayCandidate(candidate({ topic }), NOW)).toBe('eligible');
    }
    for (const topic of ['app/uninstalled', 'products/update', 'refunds/create', 'inconnu']) {
      expect(classifyReplayCandidate(candidate({ topic }), NOW)).toBe('unsupported_topic');
    }
  });

  it('ne reprend que ce qui est en attente', () => {
    for (const status of ['done', 'terminal']) {
      expect(classifyReplayCandidate(candidate({ status }), NOW)).toBe('not_pending');
    }
  });

  it('échéance : due seulement au-delà de la marge d’horloge ; absente, jamais due', () => {
    const at = (ms: number) =>
      classifyReplayCandidate(candidate({ next_attempt_at: ago(ms) }), NOW);
    expect(at(WEBHOOK_REPLAY_CLOCK_MARGIN_MS + 1_000)).toBe('eligible');
    expect(at(WEBHOOK_REPLAY_CLOCK_MARGIN_MS)).toBe('eligible');
    expect(at(WEBHOOK_REPLAY_CLOCK_MARGIN_MS - 1_000)).toBe('not_due');
    expect(at(-60_000)).toBe('not_due');
    expect(classifyReplayCandidate(candidate({ next_attempt_at: null }), NOW)).toBe('not_due');
  });

  it('en cours : repris seulement quand le bail est expiré au-delà de la marge', () => {
    const at = (ms: number) =>
      classifyReplayCandidate(
        candidate({ lease_until: ago(ms), next_attempt_at: null, status: 'processing' }),
        NOW,
      );
    expect(at(WEBHOOK_REPLAY_CLOCK_MARGIN_MS + 1_000)).toBe('eligible');
    expect(at(WEBHOOK_REPLAY_CLOCK_MARGIN_MS)).toBe('leased');
    expect(at(1_000)).toBe('leased');
    expect(at(-4 * 60_000)).toBe('leased');
    expect(
      classifyReplayCandidate(
        candidate({ lease_until: null, next_attempt_at: null, status: 'processing' }),
        NOW,
      ),
    ).toBe('eligible');
  });

  it('plafond de tentatives et fenêtre d’âge', () => {
    const attempts = (n: number) => classifyReplayCandidate(candidate({ attempt_count: n }), NOW);
    expect(attempts(WEBHOOK_REPLAY_MAX_ATTEMPTS - 1)).toBe('eligible');
    expect(attempts(WEBHOOK_REPLAY_MAX_ATTEMPTS)).toBe('exhausted');
    expect(attempts(WEBHOOK_REPLAY_MAX_ATTEMPTS + 3)).toBe('exhausted');

    const received = (ms: number) =>
      classifyReplayCandidate(candidate({ received_at: ago(ms) }), NOW);
    expect(received(WEBHOOK_REPLAY_WINDOW_MS - 60_000)).toBe('eligible');
    expect(received(WEBHOOK_REPLAY_WINDOW_MS + 60_000)).toBe('too_old');
  });

  it("l'instant présenté à la base est en retard de la marge", () => {
    expect(replayClaimInstant(NOW).getTime()).toBe(NOW.getTime() - WEBHOOK_REPLAY_CLOCK_MARGIN_MS);
  });

  // Sans primitive de fencing sur la clôture d'un événement, c'est cet ordre de grandeurs qui
  // interdit à deux exécutions de traiter le même événement : une exécution est morte avant que
  // le bail de ce qu'elle a réclamé n'expire.
  it('non-recouvrement : l’exécution est plus courte que le bail qu’elle pose', () => {
    expect(replayNonOverlapHolds()).toBe(true);
    expect(WEBHOOK_REPLAY_BUDGET_MS).toBeLessThan(WEBHOOK_REPLAY_MAX_DURATION_S * 1_000);
    expect(WEBHOOK_REPLAY_MAX_DURATION_S * 1_000).toBeLessThan(
      WEBHOOK_LEASE_MS - WEBHOOK_REPLAY_CLOCK_MARGIN_MS,
    );
  });

  it('la route du cron porte cette durée, et le cron est déclaré', () => {
    const route = readFileSync(
      resolve(ROOT, 'app/api/cron/shopify-webhook-retry/route.ts'),
      'utf8',
    );
    expect(route).toContain(`export const maxDuration = ${WEBHOOK_REPLAY_MAX_DURATION_S};`);

    const vercel = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8')) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const cron = vercel.crons.filter((entry) => entry.path === '/api/cron/shopify-webhook-retry');
    expect(cron).toHaveLength(1);
    // Une fois par jour : la seule cadence admise par tous les plans de l'hébergeur.
    expect(cron[0]?.schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
  });
});
