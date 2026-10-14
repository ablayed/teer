import {
  WEBHOOK_REPLAY_CLOCK_MARGIN_MS,
  replayClaimInstant,
} from '@/lib/shopify/webhook-replay-policy';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// La réclamation est la seule garde qui tienne quand l'état change entre la lecture et l'écriture.
// Le filtre applicatif écarte déjà un bail en cours ; ce test verrouille ce que la reprise
// présente à la BASE : un événement à la fois, par son identifiant, à l'instant décalé de la marge.

const core = vi.hoisted(() => ({
  finishWebhookStatus: vi.fn(),
  resolveShopForTopic: vi.fn(),
  resolveShopLenient: vi.fn(),
  runResolvedWebhookEvent: vi.fn(),
}));

vi.mock('@/lib/shopify/webhook-core', () => ({
  ...core,
  isTerminalWebhookError: (error: Error) => error.message.startsWith('gdpr_shop_domain_'),
}));
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }));

const NOW = new Date('2026-10-13T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function row(id: string, patch: Record<string, unknown> = {}) {
  return {
    attempt_count: 1,
    id,
    lease_until: null,
    next_attempt_at: ago(10 * 60_000),
    received_at: ago(60 * 60_000),
    shop_domain: 'boutique.myshopify.com',
    shop_id: 'shop-1',
    shopify_webhook_id: `livraison-${id}`,
    status: 'retryable',
    topic: 'orders/updated',
    triggered_at: null,
    ...patch,
  };
}

function fakeAdmin(rows: unknown[], claimed: (id: string) => unknown[]) {
  const rpc = vi.fn(
    async (_name: string, args: { p_event_id: string; p_limit: number; p_now: string }) => ({
      data: claimed(args.p_event_id),
      error: null,
    }),
  );
  // Trois lectures : les candidats (colonnes commençant par `id,`), le décompte des événements à
  // regarder (rien ici), puis le statut d'un événement repris.
  const orders: unknown[][] = [];
  const chain = (data: unknown[]) => {
    const scan = {
      gte: () => scan,
      in: () => scan,
      limit: async () => ({ data, error: null }),
      lt: () => scan,
      or: () => scan,
      order: (...args: unknown[]) => {
        orders.push(args);
        return scan;
      },
    };
    return scan;
  };
  const status = {
    eq: () => ({ maybeSingle: async () => ({ data: { status: 'done' }, error: null }) }),
  };
  const from = vi.fn(() => ({
    select: (columns: string) => {
      if (columns.startsWith('id,')) return chain(rows);
      if (columns.startsWith('topic,')) return chain([]);
      return status;
    },
  }));
  return { admin: { from, rpc } as unknown as SupabaseClient<Database>, orders, rpc };
}

describe('reprise des webhooks — ce qui est présenté à la base', () => {
  beforeEach(() => {
    for (const mock of Object.values(core)) mock.mockReset();
    core.resolveShopForTopic.mockResolvedValue({ id: 'shop-1' });
  });

  it('réclame un événement à la fois, par son identifiant, à l’instant décalé de la marge', async () => {
    const { replayPendingShopifyWebhooks } = await import('@/lib/shopify/webhook-replay');
    const { admin, orders, rpc } = fakeAdmin(
      [row('a'), row('b', { received_at: ago(30 * 60_000) })],
      () => [
        {
          payload: { id: 1 },
          shop_domain: 'boutique.myshopify.com',
          shop_id: 'shop-1',
          topic: 'orders/updated',
        },
      ],
    );

    await replayPendingShopifyWebhooks(admin, { now: NOW });

    expect(rpc.mock.calls.map(([name, args]) => [name, args])).toEqual([
      [
        'claim_shopify_webhook_events',
        { p_event_id: 'a', p_limit: 1, p_now: replayClaimInstant(NOW).toISOString() },
      ],
      [
        'claim_shopify_webhook_events',
        { p_event_id: 'b', p_limit: 1, p_now: replayClaimInstant(NOW).toISOString() },
      ],
    ]);
    expect(Date.parse(rpc.mock.calls[0]?.[1].p_now as string)).toBe(
      NOW.getTime() - WEBHOOK_REPLAY_CLOCK_MARGIN_MS,
    );
    // Dans l'ordre de réception : la base trie, le plus ancien d'abord (la création avant la mise à jour).
    expect(orders[0]).toEqual(['received_at', { ascending: true }]);
    expect(core.runResolvedWebhookEvent.mock.calls.map(([args]) => args.eventId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('refusée par la base : aucun traitement, et le relevé le dit', async () => {
    const { replayPendingShopifyWebhooks } = await import('@/lib/shopify/webhook-replay');
    const { admin } = fakeAdmin([row('a')], () => []);

    const summary = await replayPendingShopifyWebhooks(admin, { now: NOW });

    expect(core.runResolvedWebhookEvent).not.toHaveBeenCalled();
    expect(core.finishWebhookStatus).not.toHaveBeenCalled();
    expect(summary.skipped.notClaimed).toBe(1);
    expect(summary.replayed).toEqual({ done: 0, retryable: 0, terminal: 0, unknown: 0 });
  });

  it('charge absente : l’événement est clos comme tel, jamais traité', async () => {
    const { replayPendingShopifyWebhooks } = await import('@/lib/shopify/webhook-replay');
    const { admin } = fakeAdmin([row('a', { topic: 'customers/data_request' })], () => [
      {
        payload: null,
        shop_domain: 'boutique.myshopify.com',
        shop_id: 'shop-1',
        topic: 'customers/data_request',
      },
    ]);

    const summary = await replayPendingShopifyWebhooks(admin, { now: NOW });

    expect(core.runResolvedWebhookEvent).not.toHaveBeenCalled();
    expect(core.finishWebhookStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'webhook_payload_unavailable',
        eventId: 'a',
        outcome: 'terminal',
      }),
    );
    expect(summary.skipped.payloadUnavailable).toBe(1);
    expect(summary.needsReview['customers/data_request']).toBe(1);
  });

  it('sujet RGPD : domaine enregistré et corps signé divergents → clos, aucune boutique résolue', async () => {
    const { replayPendingShopifyWebhooks } = await import('@/lib/shopify/webhook-replay');
    const { admin } = fakeAdmin(
      [row('a', { shop_domain: 'victime.myshopify.com', topic: 'shop/redact' })],
      () => [
        {
          payload: { shop_domain: 'autre.myshopify.com' },
          shop_domain: 'victime.myshopify.com',
          shop_id: 'shop-1',
          topic: 'shop/redact',
        },
      ],
    );

    await replayPendingShopifyWebhooks(admin, { now: NOW });

    expect(core.finishWebhookStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'gdpr_shop_domain_mismatch',
        eventId: 'a',
        outcome: 'terminal',
      }),
    );
    expect(core.resolveShopForTopic).not.toHaveBeenCalled();
    expect(core.runResolvedWebhookEvent).not.toHaveBeenCalled();
  });

  it('sujet RGPD : la boutique vient du domaine du corps signé, jamais de la boutique enregistrée', async () => {
    const { replayPendingShopifyWebhooks } = await import('@/lib/shopify/webhook-replay');
    const { admin } = fakeAdmin(
      [row('a', { shop_domain: 'Boutique.MyShopify.com ', topic: 'customers/redact' })],
      () => [
        {
          payload: { customer: { id: 7 }, shop_domain: 'boutique.myshopify.com' },
          shop_domain: 'Boutique.MyShopify.com ',
          shop_id: 'shop-1',
          topic: 'customers/redact',
        },
      ],
    );

    await replayPendingShopifyWebhooks(admin, { now: NOW });

    expect(core.resolveShopForTopic).toHaveBeenCalledWith(admin, 'customers/redact', {
      by: 'domain',
      shopDomain: 'boutique.myshopify.com',
    });
    expect(core.runResolvedWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'a',
        resolvedShopDomain: 'boutique.myshopify.com',
        validatedClientId: null,
      }),
    );
  });

  it('budget épuisé : plus aucune réclamation', async () => {
    const { replayPendingShopifyWebhooks } = await import('@/lib/shopify/webhook-replay');
    const { admin, rpc } = fakeAdmin([row('a'), row('b')], () => []);

    const summary = await replayPendingShopifyWebhooks(admin, { budgetMs: -1, now: NOW });

    expect(rpc).not.toHaveBeenCalled();
    expect(summary.stoppedOnBudget).toBe(true);
  });
});
