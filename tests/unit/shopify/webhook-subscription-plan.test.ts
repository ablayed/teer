import {
  ADMIN_API_TOPICS,
  decideConnectionApplyPlan,
  planTopicAction,
} from '@/scripts/lib/webhook-subscription-plan.mjs';
import { describe, expect, it } from 'vitest';

const OUR_ORIGIN = 'https://webhooks.example.com';

function httpEndpoint(callbackUrl: string) {
  return { __typename: 'WebhookHttpEndpoint', callbackUrl };
}

describe('planTopicAction', () => {
  it("aucun abonnement existant -> 'creer'", () => {
    const result = planTopicAction({
      existingForTopic: [],
      knownPublicId: null,
      ourOrigin: OUR_ORIGIN,
    });
    expect(result.action).toBe('creer');
  });

  it("abonnement pointant vers le jeton local connu -> 'conforme', existingId préservé", () => {
    const result = planTopicAction({
      existingForTopic: [
        {
          id: 'gid://shopify/WebhookSubscription/1',
          endpoint: httpEndpoint(`${OUR_ORIGIN}/api/shopify/ingest/pub123.secretABC`),
        },
      ],
      knownPublicId: 'pub123',
      ourOrigin: OUR_ORIGIN,
    });
    expect(result.action).toBe('conforme');
    expect(result.existingId).toBe('gid://shopify/WebhookSubscription/1');
  });

  it("abonnement pointant vers un public_id différent -> 'remplacer'", () => {
    const result = planTopicAction({
      existingForTopic: [
        {
          id: 'gid://shopify/WebhookSubscription/1',
          endpoint: httpEndpoint(`${OUR_ORIGIN}/api/shopify/ingest/OLD.secretABC`),
        },
      ],
      knownPublicId: 'pub123',
      ourOrigin: OUR_ORIGIN,
    });
    expect(result.action).toBe('remplacer');
    expect(result.existingId).toBe('gid://shopify/WebhookSubscription/1');
  });

  it("abonnement pointant vers une autre origine (ancien endpoint) -> 'remplacer'", () => {
    const result = planTopicAction({
      existingForTopic: [
        {
          id: 'gid://shopify/WebhookSubscription/1',
          endpoint: httpEndpoint('https://teer-dev.vercel.app/api/shopify/webhooks'),
        },
      ],
      knownPublicId: 'pub123',
      ourOrigin: OUR_ORIGIN,
    });
    expect(result.action).toBe('remplacer');
  });

  it("endpoint non-HTTP (EventBridge/PubSub) -> 'remplacer'", () => {
    const result = planTopicAction({
      existingForTopic: [
        {
          id: 'gid://shopify/WebhookSubscription/1',
          endpoint: { __typename: 'WebhookEventBridgeEndpoint' },
        },
      ],
      knownPublicId: 'pub123',
      ourOrigin: OUR_ORIGIN,
    });
    expect(result.action).toBe('remplacer');
  });

  it("plusieurs abonnements simultanés sur le même topic -> 'anomalie_multiple'", () => {
    const result = planTopicAction({
      existingForTopic: [
        { id: 'a', endpoint: httpEndpoint(`${OUR_ORIGIN}/api/shopify/ingest/pub123.x`) },
        { id: 'b', endpoint: httpEndpoint(`${OUR_ORIGIN}/api/shopify/ingest/pub123.x`) },
      ],
      knownPublicId: 'pub123',
      ourOrigin: OUR_ORIGIN,
    });
    expect(result.action).toBe('anomalie_multiple');
  });

  it("Shopify pointe déjà vers l'URL opaque mais aucun jeton local -> 'anomalie_token_local_absent'", () => {
    const result = planTopicAction({
      existingForTopic: [
        {
          id: 'gid://shopify/WebhookSubscription/1',
          endpoint: httpEndpoint(`${OUR_ORIGIN}/api/shopify/ingest/pub123.secretABC`),
        },
      ],
      knownPublicId: null,
      ourOrigin: OUR_ORIGIN,
    });
    expect(result.action).toBe('anomalie_token_local_absent');
  });
});

describe('decideConnectionApplyPlan — invariant central : jamais de rotation implicite', () => {
  const conformeTopics = ADMIN_API_TOPICS.map((t) => ({
    topic: t.rest,
    action: 'conforme',
    existingId: `id-${t.rest}`,
  }));

  it("tous conformes -> 'already_conformant' (aucune mutation, quel que soit hasLocalToken)", () => {
    expect(decideConnectionApplyPlan({ topics: conformeTopics, hasLocalToken: true }).kind).toBe(
      'already_conformant',
    );
  });

  it("un topic 'creer' + AUCUN jeton local -> 'provision' (première bascule, sans risque)", () => {
    const topics = [{ topic: 'orders/create', action: 'creer' }, ...conformeTopics.slice(1)];
    const decision = decideConnectionApplyPlan({ topics, hasLocalToken: false });
    expect(decision.kind).toBe('provision');
  });

  it("un topic 'creer' + jeton local EXISTANT -> 'requires_rotation' (jamais mutée par --apply — " +
    'le bug corrigé : faire tourner ici invaliderait les 8 autres topics déjà conformes)', () => {
    const topics = [{ topic: 'orders/create', action: 'creer' }, ...conformeTopics.slice(1)];
    const decision = decideConnectionApplyPlan({ topics, hasLocalToken: true });
    expect(decision.kind).toBe('requires_rotation');
  });

  it("une anomalie l'emporte toujours, même avec des topics par ailleurs actionnables", () => {
    const topics = [
      { topic: 'orders/create', action: 'anomalie_multiple', detail: 'x' },
      { topic: 'products/create', action: 'creer' },
      ...conformeTopics.slice(2),
    ];
    expect(decideConnectionApplyPlan({ topics, hasLocalToken: false }).kind).toBe(
      'blocked_anomalie',
    );
    expect(decideConnectionApplyPlan({ topics, hasLocalToken: true }).kind).toBe(
      'blocked_anomalie',
    );
  });
});

describe('Idempotence de --apply, prouvée sur les 3 invariants (pas supposée)', () => {
  // Simule l'état Shopify APRÈS un premier --apply réussi : les 9 topics pointent vers le MÊME
  // jeton local, chacun avec un identifiant d'abonnement Shopify fixe.
  const publicId = 'pubStable123';
  const afterFirstApply = ADMIN_API_TOPICS.map((t, i) => ({
    graphql: t.graphql,
    rest: t.rest,
    subscription: {
      id: `gid://shopify/WebhookSubscription/${i}`,
      endpoint: httpEndpoint(`${OUR_ORIGIN}/api/shopify/ingest/${publicId}.secretXYZ`),
    },
  }));

  it('un second passage de planification reproduit EXACTEMENT le même diagnostic (conforme, mêmes ids)', () => {
    const secondPassTopics = afterFirstApply.map(({ rest, subscription }) => {
      const result = planTopicAction({
        existingForTopic: [subscription],
        knownPublicId: publicId,
        ourOrigin: OUR_ORIGIN,
      });
      return { topic: rest, ...result };
    });

    // Invariant #2 (URL cible) : chaque topic est 'conforme', jamais 'remplacer'/'creer'.
    for (const t of secondPassTopics) {
      expect(t.action).toBe('conforme');
    }
    // Invariant #3 (identifiant Shopify) : l'existingId rapporté au second passage est
    // EXACTEMENT celui déjà en place — rien n'a été recréé.
    for (let i = 0; i < secondPassTopics.length; i++) {
      expect(secondPassTopics[i].existingId).toBe(afterFirstApply[i].subscription.id);
    }

    // Invariant #1 (jeton) : la décision globale ne déclenche aucune mutation de jeton — c'est
    // 'already_conformant' qui le garantit structurellement (applyConnection ne fait alors AUCUN
    // appel à createWebhookToken/rotateWebhookToken, cf. webhook-subscription-migration.mjs).
    const decision = decideConnectionApplyPlan({ topics: secondPassTopics, hasLocalToken: true });
    expect(decision.kind).toBe('already_conformant');
  });

  it('état MIXTE réaliste (8 topics déjà conformes + 1 dérivé manuellement chez Shopify) -> ' +
    "'requires_rotation', jamais 'already_conformant' ni 'provision' — c'est exactement le " +
    'scénario qui a exposé le bug : un seul topic actionnable ne doit jamais entraîner de ' +
    'rotation qui invaliderait les 8 autres.', () => {
    const mixedTopics = afterFirstApply.map(({ rest, subscription }, i) => {
      // Le premier topic a été pointé ailleurs manuellement (config de test, ancien endpoint) —
      // les 8 autres restent sur le jeton courant.
      const existingForTopic =
        i === 0
          ? [
              {
                id: subscription.id,
                endpoint: httpEndpoint('https://teer-dev.vercel.app/api/shopify/webhooks'),
              },
            ]
          : [subscription];
      const result = planTopicAction({
        existingForTopic,
        knownPublicId: publicId,
        ourOrigin: OUR_ORIGIN,
      });
      return { topic: rest, ...result };
    });

    expect(mixedTopics[0].action).toBe('remplacer');
    for (const t of mixedTopics.slice(1)) {
      expect(t.action).toBe('conforme');
    }

    const decision = decideConnectionApplyPlan({ topics: mixedTopics, hasLocalToken: true });
    if (decision.kind !== 'requires_rotation') {
      throw new Error(`expected 'requires_rotation', got '${decision.kind}'`);
    }
    expect(decision.actionable).toHaveLength(1);
  });
});
