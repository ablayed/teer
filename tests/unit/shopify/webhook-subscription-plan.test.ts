// Diagnostic en lecture seule des abonnements webhook Shopify
// (scripts/webhook-subscription-migration.mjs --plan) — logique pure et propagation du jeton.
//
// SHOPIFY-WEBHOOKS-PER-SHOP-1B / G10 — `--apply` et `--rotate-token` sont retirés : les tests de
// leur décision (planTopicAction, decideConnectionApplyPlan, renouvellement en mode apply) ont
// disparu avec eux. La reconnaissance d'un abonnement est prouvée dans
// tests/unit/shopify/webhook-subscription-inventory.test.ts ; la réconciliation, contre
// PostgreSQL, dans tests/rls/shopify-webhooks-1b-reconcile.rls.test.ts.
import { generateWebhookToken } from '@/lib/ingestion/webhook-token';
import {
  PER_SHOP_SUBSCRIPTION_TOPICS,
  controlledErrorMessage,
  maskSensitiveText,
  resolvePlanAccessToken,
  resolveSingleConnectionSelection,
  resolveSingleShopSelection,
  scopeActiveConnectionQuery,
  scopeShopQuery,
  summarizeReconcileOutlook,
  summarizeTopicStates,
  validateShopDomainSelection,
} from '@/scripts/lib/webhook-subscription-plan.mjs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/shopify/crypto.ts', () => ({ decryptToken: vi.fn() }));
vi.mock('../../../lib/shopify/graphql.ts', () => ({ shopifyGraphQL: vi.fn() }));

describe('ciblage explicite de la boutique pilote', () => {
  it('exige un domaine canonique myshopify exact', () => {
    expect(validateShopDomainSelection(undefined)).toEqual({
      ok: false,
      reason: 'shop_domain_required',
    });
    expect(validateShopDomainSelection('pilot.example.com')).toEqual({
      ok: false,
      reason: 'shop_domain_must_be_canonical',
    });
    expect(validateShopDomainSelection('ntmwxz-83.myshopify.com')).toEqual({
      ok: true,
      shopDomain: 'ntmwxz-83.myshopify.com',
    });
  });

  it('refuse une sélection absente ou ambiguë avant les credentials', () => {
    expect(resolveSingleShopSelection([], 'ntmwxz-83.myshopify.com')).toEqual({
      ok: false,
      reason: 'shop_not_found',
    });
    expect(
      resolveSingleShopSelection(
        [
          { id: 'shop-a', shop_domain: 'ntmwxz-83.myshopify.com' },
          { id: 'shop-b', shop_domain: 'ntmwxz-83.myshopify.com' },
        ],
        'ntmwxz-83.myshopify.com',
      ),
    ).toEqual({ ok: false, reason: 'shop_domain_ambiguous' });
    expect(resolveSingleConnectionSelection([])).toEqual({
      ok: false,
      reason: 'shop_connection_not_found',
    });
    expect(resolveSingleConnectionSelection([{ id: 'a' }, { id: 'b' }])).toEqual({
      ok: false,
      reason: 'shop_connection_ambiguous',
    });
  });

  it('applique le domaine et le shop_id dans les requêtes avant tout credential', () => {
    const calls: Array<[string, string]> = [];
    const query = {
      eq(field: string, value: string) {
        calls.push([field, value]);
        return this;
      },
    };
    scopeShopQuery(query, 'ntmwxz-83.myshopify.com');
    scopeActiveConnectionQuery(query, 'shop-a');
    expect(calls).toEqual([
      ['shop_domain', 'ntmwxz-83.myshopify.com'],
      ['platform', 'shopify'],
      ['status', 'active'],
      ['shop_id', 'shop-a'],
    ]);
  });
});

describe('mode plan strictement sans renouvellement ni écriture', () => {
  it('refuse le renouvellement requis : le diagnostic ne rafraîchit jamais un jeton', () => {
    const result = resolvePlanAccessToken({
      encryptedToken: 'encrypted-token-sentinel',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      decrypt: () => 'access-token-sentinel',
      refreshBufferMs: 5 * 60 * 1000,
    });
    expect(result).toEqual({ ok: false, reason: 'renewal_required' });
  });

  it('utilise un token encore valide sans renouvellement', () => {
    const result = resolvePlanAccessToken({
      encryptedToken: 'encrypted-token-sentinel',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      decrypt: () => 'access-token-sentinel',
      refreshBufferMs: 5 * 60 * 1000,
    });
    expect(result).toEqual({ ok: true, accessToken: 'access-token-sentinel' });
  });

  it('utilise tel quel un jeton non expirant (app custom)', () => {
    expect(
      resolvePlanAccessToken({
        encryptedToken: 'encrypted-token-sentinel',
        expiresAt: null,
        decrypt: () => 'access-token-sentinel',
      }),
    ).toEqual({ ok: true, accessToken: 'access-token-sentinel' });
  });
});

describe('erreurs contrôlées et masquage', () => {
  it('ne restitue aucune sentinelle depuis message, propriétés ou cause', () => {
    const sentinel = 'opaque-token-sentinel';
    const error = new Error(`message=${sentinel}`, {
      cause: Object.assign(new Error(`cause=${sentinel}`), {
        response: { callbackUrl: `https://webhooks.example.com/api/shopify/ingest/${sentinel}` },
      }),
    });
    Object.assign(error, { secret: sentinel, nested: { value: sentinel } });
    expect(controlledErrorMessage(error)).not.toContain(sentinel);
    expect(controlledErrorMessage(error)).toMatch(/^cause=/);
    expect(
      maskSensitiveText(
        `provider rejected https://webhooks.example.com/api/shopify/ingest/${sentinel}`,
      ),
    ).toBe('provider rejected https://webhooks.example.com/api/shopify/ingest/***');
  });
});

describe('summarizeTopicStates et summarizeReconcileOutlook — ce que la réconciliation ferait', () => {
  const current = { kind: 'current' as const };
  const previous = { kind: 'previous' as const };
  const foreign = { kind: 'foreign' as const, onOurOrigin: true };

  function everyTopic(classification: typeof current | typeof previous) {
    return PER_SHOP_SUBSCRIPTION_TOPICS.map((topic) => ({ topic: topic.graphql, classification }));
  }

  it('attend neuf topics, app/uninstalled compris', () => {
    const topics = summarizeTopicStates([], PER_SHOP_SUBSCRIPTION_TOPICS);
    expect(topics).toHaveLength(9);
    expect(topics.map((topic) => topic.topic)).toContain('app/uninstalled');
  });

  it('inventaire vide : tout est absent, donc rotation', () => {
    const topics = summarizeTopicStates([], PER_SHOP_SUBSCRIPTION_TOPICS);
    expect(topics.every((topic) => topic.state === 'absent')).toBe(true);
    expect(summarizeReconcileOutlook(topics)).toBe('rotation');
  });

  it('neuf abonnements courants : aucune action', () => {
    const topics = summarizeTopicStates(everyTopic(current), PER_SHOP_SUBSCRIPTION_TOPICS);
    expect(topics.every((topic) => topic.state === 'conforme')).toBe(true);
    expect(summarizeReconcileOutlook(topics)).toBe('aucune_action');
  });

  it('un topic manquant parmi des courants : création sans rotation', () => {
    const classified = everyTopic(current).filter((entry) => entry.topic !== 'ORDERS_UPDATED');
    const topics = summarizeTopicStates(classified, PER_SHOP_SUBSCRIPTION_TOPICS);
    expect(topics.find((topic) => topic.topic === 'orders/updated')?.state).toBe('absent');
    expect(summarizeReconcileOutlook(topics)).toBe('creation_sans_rotation');
  });

  it('seulement des abonnements précédents : aucun courant, donc rotation', () => {
    const topics = summarizeTopicStates(everyTopic(previous), PER_SHOP_SUBSCRIPTION_TOPICS);
    expect(topics.every((topic) => topic.state === 'precedent')).toBe(true);
    expect(summarizeReconcileOutlook(topics)).toBe('rotation');
  });

  it('compte les doublons et les abonnements non reconnus sans les prendre pour conformes', () => {
    const topics = summarizeTopicStates(
      [
        { topic: 'ORDERS_CREATE', classification: current },
        { topic: 'ORDERS_CREATE', classification: current },
        { topic: 'ORDERS_UPDATED', classification: foreign },
      ],
      PER_SHOP_SUBSCRIPTION_TOPICS,
    );
    expect(topics.find((topic) => topic.topic === 'orders/create')).toMatchObject({
      state: 'conforme',
      current: 2,
      doublons: 1,
    });
    expect(topics.find((topic) => topic.topic === 'orders/updated')).toMatchObject({
      state: 'absent',
      foreign: 1,
    });
  });
});

type PlanResult = {
  blocked: boolean;
  reason?: string;
  topics?: Array<{ topic: string; state: string }>;
  inventory?: Array<{ topic: string; classification: string; uri: string }>;
  outlook?: string;
  localToken?: string;
};

type KnownToken = {
  public_id: string;
  secret_hash: string;
  previous_secret_hash: string | null;
  revoked_at: string | null;
} | null;

type PlanConnection = (args: {
  connection: { id: string };
  shop: {
    shop_domain: string;
    access_token_encrypted?: string | null;
    access_token_expires_at?: string | null;
  };
  app: { label: string };
  knownToken: KnownToken;
}) => Promise<PlanResult>;

type PlanInput = Parameters<PlanConnection>[0];

describe('planConnection — propagation du résultat de jeton', () => {
  let planConnection: PlanConnection;
  let decryptToken: ReturnType<typeof vi.fn>;
  let shopifyGraphQL: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const previousArgv = process.argv;
    const environment = {
      NODE_ENV: 'test',
      WEBHOOK_MIGRATION_SUPABASE_URL: 'https://maintenance.example.test',
      WEBHOOK_MIGRATION_SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-sentinel',
      WEBHOOK_MIGRATION_SUPABASE_ALLOWED_ORIGIN: 'https://maintenance.example.test',
      WEBHOOK_PUBLIC_BASE_URL: 'https://webhooks.example.test',
      SHOPIFY_TOKEN_ENCRYPTION_KEY: 'encryption-test-sentinel',
      SHOPIFY_KOBA_API_KEY: 'client-test-sentinel',
      SHOPIFY_KOBA_API_SECRET: 'secret-test-sentinel',
    } as const;
    const previousEnvironment = new Map(
      Object.keys(environment).map((key) => [key, process.env[key]]),
    );

    process.argv = [
      process.execPath,
      'scripts/webhook-subscription-migration.mjs',
      '--plan',
      '--shop-domain',
      'pilot.myshopify.com',
    ];
    for (const [key, value] of Object.entries(environment)) {
      process.env[key] = value;
    }

    const migration = (await import(
      new URL('../../../scripts/webhook-subscription-migration.mjs', import.meta.url).href
    )) as { planConnection: PlanConnection };
    planConnection = migration.planConnection;

    const crypto = await import('../../../lib/shopify/crypto');
    const graphql = await import('../../../lib/shopify/graphql');
    decryptToken = crypto.decryptToken as unknown as ReturnType<typeof vi.fn>;
    shopifyGraphQL = graphql.shopifyGraphQL as unknown as ReturnType<typeof vi.fn>;

    process.argv = previousArgv;
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function planInput(shop: PlanInput['shop'], knownToken: KnownToken = null): PlanInput {
    return {
      connection: { id: 'connection-pilot' },
      shop,
      app: { label: 'teer-koba' },
      knownToken,
    };
  }

  const validShop = {
    shop_domain: 'pilot.myshopify.com',
    access_token_encrypted: 'encrypted-test-sentinel',
    access_token_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  };

  function page(nodes: unknown[], endCursor: string | null = null) {
    return {
      webhookSubscriptions: {
        edges: nodes.map((node) => ({ node })),
        pageInfo: { hasNextPage: endCursor !== null, endCursor },
      },
    };
  }

  function localToken(token: { publicId: string; secretHash: string }, revoked = false) {
    return {
      public_id: token.publicId,
      secret_hash: token.secretHash,
      previous_secret_hash: null,
      revoked_at: revoked ? new Date().toISOString() : null,
    };
  }

  it('remonte needs_reauth', async () => {
    const result = await planConnection(
      planInput({ shop_domain: 'pilot.myshopify.com', access_token_encrypted: null }),
    );
    expect(result).toMatchObject({ blocked: true, reason: 'needs_reauth' });
  });

  it('remonte token_error', async () => {
    decryptToken.mockImplementation(() => {
      throw new Error('decrypt-test-sentinel');
    });
    const result = await planConnection(
      planInput({
        shop_domain: 'pilot.myshopify.com',
        access_token_encrypted: 'encrypted-test-sentinel',
        access_token_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      }),
    );
    expect(result).toMatchObject({ blocked: true, reason: 'token_error' });
  });

  it('remonte renewal_required', async () => {
    decryptToken.mockReturnValue('access-test-sentinel');
    const result = await planConnection(
      planInput({
        shop_domain: 'pilot.myshopify.com',
        access_token_encrypted: 'encrypted-test-sentinel',
        access_token_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    expect(result).toMatchObject({ blocked: true, reason: 'renewal_required' });
  });

  it("poursuit le plan valide jusqu'à l'inventaire et au diagnostic par topic", async () => {
    decryptToken.mockReturnValue('access-test-sentinel');
    shopifyGraphQL.mockResolvedValue(page([]));

    const result = await planConnection(planInput(validShop));

    expect(result.blocked).toBe(false);
    expect(shopifyGraphQL).toHaveBeenCalledTimes(1);
    expect(shopifyGraphQL).toHaveBeenCalledWith(
      expect.objectContaining({ shopDomain: 'pilot.myshopify.com' }),
    );
    expect(result.topics).toHaveLength(9);
    expect(result.topics?.find((topic) => topic.topic === 'orders/create')).toMatchObject({
      state: 'absent',
    });
    expect(result.localToken).toBe('absent');
    expect(result.outlook).toBe('rotation');
  });

  it('inventaire PAGINÉ : suit le curseur et classe un abonnement de la seconde page', async () => {
    decryptToken.mockReturnValue('access-test-sentinel');
    const token = generateWebhookToken();
    const currentUri = `https://webhooks.example.test/api/shopify/ingest/${token.raw}`;
    shopifyGraphQL
      .mockResolvedValueOnce(
        page(
          [{ id: 'gid://1', topic: 'ORDERS_CREATE', uri: 'https://ailleurs.example.test/h' }],
          '1',
        ),
      )
      .mockResolvedValueOnce(
        page([
          {
            id: 'gid://2',
            topic: 'ORDERS_UPDATED',
            uri: currentUri,
            apiVersion: { handle: '2026-04' },
          },
        ]),
      );

    const result = await planConnection(planInput(validShop, localToken(token)));

    expect(shopifyGraphQL).toHaveBeenCalledTimes(2);
    expect(shopifyGraphQL.mock.calls[1][0].variables).toMatchObject({ after: '1' });
    expect(result.topics?.find((topic) => topic.topic === 'orders/updated')?.state).toBe(
      'conforme',
    );
    expect(result.topics?.find((topic) => topic.topic === 'orders/create')?.state).toBe('absent');
    expect(result.outlook).toBe('creation_sans_rotation');
    expect(result.localToken).toBe('présent');
  });

  it('sortie MASQUÉE : ni le secret ni le publicId du jeton ne sortent du diagnostic', async () => {
    decryptToken.mockReturnValue('access-test-sentinel');
    const token = generateWebhookToken();
    shopifyGraphQL.mockResolvedValue(
      page([
        {
          id: 'gid://1',
          topic: 'ORDERS_CREATE',
          uri: `https://webhooks.example.test/api/shopify/ingest/${token.raw}`,
        },
      ]),
    );

    const result = await planConnection(planInput(validShop, localToken(token)));

    expect(result.inventory?.[0]).toMatchObject({
      classification: 'courant',
      uri: 'https://webhooks.example.test/api/shopify/ingest/***',
    });
    const serialized = JSON.stringify({ inventory: result.inventory, topics: result.topics });
    expect(serialized).not.toContain(token.secret);
    expect(serialized).not.toContain(token.publicId);
    // Le jeton d'accès Admin ne sort pas non plus du processus.
    expect(JSON.stringify(result)).not.toContain('access-test-sentinel');
  });

  it('jeton local révoqué : rien ne reste reconnu comme courant', async () => {
    decryptToken.mockReturnValue('access-test-sentinel');
    const token = generateWebhookToken();
    shopifyGraphQL.mockResolvedValue(
      page([
        {
          id: 'gid://1',
          topic: 'ORDERS_CREATE',
          uri: `https://webhooks.example.test/api/shopify/ingest/${token.raw}`,
        },
      ]),
    );

    const result = await planConnection(planInput(validShop, localToken(token, true)));

    expect(result.localToken).toBe('révoqué');
    expect(result.inventory?.[0].classification).toBe('non reconnu (notre origine)');
    expect(result.outlook).toBe('rotation');
  });
});
