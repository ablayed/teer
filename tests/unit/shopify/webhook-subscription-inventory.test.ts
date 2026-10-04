// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C2 — inventaire paginé, reconnaissance en quatre conditions,
// masquage.
//
// Couche : unitaire, fonctions pures. Les secrets sont synthétiques, générés à l'exécution.
import {
  generateWebhookToken,
  hashWebhookTokenSecret,
  verifyWebhookTokenSecret,
} from '@/lib/ingestion/webhook-token';
import {
  INGEST_PATH_PREFIX,
  type SubscriptionRecognitionContext,
  WEBHOOK_SUBSCRIPTIONS_MAX_PAGES,
  type WebhookGraphQLExecutor,
  buildIngestUri,
  classifySubscriptionUri,
  listWebhookSubscriptions,
  maskSubscriptionUri,
  parseWebhookPublicBaseUrl,
} from '@/lib/shopify/webhook-subscription-inventory';
import { describe, expect, it, vi } from 'vitest';

const BASE = 'https://synthetic-test-webhooks.example.test';
const current = generateWebhookToken();
const previousSecret = generateWebhookToken().secret;
const otherPublicId = generateWebhookToken().publicId;

function context(overrides: Partial<SubscriptionRecognitionContext> = {}) {
  return {
    baseOrigin: BASE,
    publicId: current.publicId,
    currentSecretHash: current.secretHash,
    previousSecretHash: hashWebhookTokenSecret(previousSecret),
    verifySecret: verifyWebhookTokenSecret,
    ...overrides,
  };
}

describe('classifySubscriptionUri — les quatre conditions', () => {
  it('origine, chemin, publicId et empreinte courante réunis → current', () => {
    expect(
      classifySubscriptionUri(buildIngestUri(BASE, current.publicId, current.secret), context()),
    ).toEqual({ kind: 'current' });
  });

  it('les trois premières réunies et l’empreinte précédente → previous', () => {
    expect(
      classifySubscriptionUri(buildIngestUri(BASE, current.publicId, previousSecret), context()),
    ).toEqual({ kind: 'previous' });
  });

  it('bonne empreinte mais AUTRE ORIGINE → foreign, hors de notre origine', () => {
    const uri = buildIngestUri(
      'https://autre-origine.example.test',
      current.publicId,
      current.secret,
    );
    expect(classifySubscriptionUri(uri, context())).toEqual({
      kind: 'foreign',
      onOurOrigin: false,
    });
  });

  it('bonne empreinte mais AUTRE CHEMIN → foreign, sur notre origine', () => {
    const uri = `${BASE}/api/shopify/webhooks/${current.publicId}.${current.secret}`;
    expect(classifySubscriptionUri(uri, context())).toEqual({ kind: 'foreign', onOurOrigin: true });
  });

  it('bonne empreinte mais segment supplémentaire, requête ou fragment → foreign', () => {
    const exact = buildIngestUri(BASE, current.publicId, current.secret);
    for (const uri of [`${exact}/suite`, `${exact}?x=1`, `${exact}#f`]) {
      expect(classifySubscriptionUri(uri, context())).toEqual({
        kind: 'foreign',
        onOurOrigin: true,
      });
    }
  });

  it('bonne empreinte mais AUTRE publicId → foreign, sur notre origine', () => {
    const uri = buildIngestUri(BASE, otherPublicId, current.secret);
    expect(classifySubscriptionUri(uri, context())).toEqual({ kind: 'foreign', onOurOrigin: true });
  });

  it('origine, chemin et publicId corrects mais empreinte inconnue → foreign', () => {
    const uri = buildIngestUri(BASE, current.publicId, generateWebhookToken().secret);
    expect(classifySubscriptionUri(uri, context())).toEqual({ kind: 'foreign', onOurOrigin: true });
  });

  it('sans jeton local, rien n’est reconnu', () => {
    const uri = buildIngestUri(BASE, current.publicId, current.secret);
    expect(
      classifySubscriptionUri(
        uri,
        context({ publicId: null, currentSecretHash: null, previousSecretHash: null }),
      ),
    ).toEqual({ kind: 'foreign', onOurOrigin: true });
  });

  it('uri absente, illisible ou non HTTP → foreign, hors de notre origine', () => {
    for (const uri of [null, '', 'pas une url', 'pubsub://projet:sujet']) {
      expect(classifySubscriptionUri(uri, context())).toEqual({
        kind: 'foreign',
        onOurOrigin: false,
      });
    }
  });

  it('compare en temps constant : le vérificateur injecté est appelé pour les DEUX empreintes', () => {
    const verifySecret = vi.fn(verifyWebhookTokenSecret);
    classifySubscriptionUri(
      buildIngestUri(BASE, current.publicId, current.secret),
      context({ verifySecret }),
    );
    expect(verifySecret).toHaveBeenCalledTimes(2);
  });
});

describe('listWebhookSubscriptions — inventaire paginé', () => {
  function pagedExecutor(total: number, pageSize: number) {
    const all = Array.from({ length: total }, (_, index) => ({
      id: `gid://shopify/WebhookSubscription/${index + 1}`,
      topic: 'ORDERS_CREATE',
      uri: `${BASE}/x/${index}`,
      apiVersion: { handle: '2026-04' },
    }));
    const calls: Array<Record<string, unknown>> = [];
    const execute = (async (_query: string, variables: Record<string, unknown>) => {
      calls.push(variables);
      const start = variables.after ? Number(variables.after) : 0;
      const slice = all.slice(start, start + pageSize);
      const end = start + slice.length;
      return {
        webhookSubscriptions: {
          edges: slice.map((node) => ({ node })),
          pageInfo: {
            hasNextPage: end < all.length,
            endCursor: end < all.length ? String(end) : null,
          },
        },
      };
    }) as WebhookGraphQLExecutor;
    return { execute, calls };
  }

  it('suit le curseur jusqu’à la dernière page et rend tous les abonnements', async () => {
    const { execute, calls } = pagedExecutor(7, 3);

    const nodes = await listWebhookSubscriptions(execute);

    expect(nodes).toHaveLength(7);
    expect(nodes.map((node) => node.id)).toEqual(
      Array.from({ length: 7 }, (_, i) => `gid://shopify/WebhookSubscription/${i + 1}`),
    );
    expect(calls.map((variables) => variables.after)).toEqual([null, '3', '6']);
    expect(nodes[0].apiVersion).toBe('2026-04');
  });

  it('une seule page : un seul appel', async () => {
    const { execute, calls } = pagedExecutor(2, 100);
    expect(await listWebhookSubscriptions(execute)).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it('au-delà de la borne de pages, lève plutôt que de tronquer en silence', async () => {
    const { execute } = pagedExecutor(WEBHOOK_SUBSCRIPTIONS_MAX_PAGES + 5, 1);
    await expect(listWebhookSubscriptions(execute)).rejects.toThrow(
      'shopify_webhook_inventory_too_large',
    );
  });
});

describe('maskSubscriptionUri — aucune sortie de diagnostic ne porte le secret', () => {
  it('remplace tout ce qui suit le préfixe d’ingestion', () => {
    const uri = buildIngestUri(BASE, current.publicId, current.secret);
    const masked = maskSubscriptionUri(uri);
    expect(masked).toBe(`${BASE}${INGEST_PATH_PREFIX}***`);
    expect(masked).not.toContain(current.secret);
    expect(masked).not.toContain(current.publicId);
  });

  it('réduit une autre uri à son origine et son chemin, sans requête', () => {
    expect(maskSubscriptionUri('https://ailleurs.example.test/hook?cle=valeur')).toBe(
      'https://ailleurs.example.test/hook',
    );
  });

  it('ne recopie jamais une valeur non HTTP ou illisible', () => {
    expect(maskSubscriptionUri('arn:aws:events:eu-west-1::event-source/exemple')).toBe('arn:***');
    expect(maskSubscriptionUri('pubsub://projet:sujet')).toBe('<uri illisible>');
    expect(maskSubscriptionUri('pas une url')).toBe('<uri illisible>');
    expect(maskSubscriptionUri(null)).toBe('<absente>');
  });
});

describe('parseWebhookPublicBaseUrl', () => {
  it('rend l’origine d’une URL HTTPS nue', () => {
    expect(parseWebhookPublicBaseUrl(BASE)).toBe(BASE);
  });

  it('refuse l’absence, HTTP, un slash final, un chemin ou une requête', () => {
    for (const raw of [
      undefined,
      null,
      '',
      'http://x.example.test',
      `${BASE}/`,
      `${BASE}/a`,
      `${BASE}?a=1`,
      'x',
    ]) {
      expect(parseWebhookPublicBaseUrl(raw)).toBeNull();
    }
  });
});
