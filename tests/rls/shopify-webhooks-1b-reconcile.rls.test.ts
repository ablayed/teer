// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C3 — réconciliation des abonnements webhook, contre
// PostgreSQL/PostgREST réels : W1 (concurrence), W2 (topic manquant), W3 (interruption), W13
// (fencing des écritures), choix du mode de rotation, non-régression KOBA.
//
// Couche : RLS/intégration. Le bail, le compare-and-set du jeton et l'écriture monotone de l'état
// sont décidés PAR LA BASE : un double de la base ne prouverait rien. Shopify, lui, est un double
// injecté (`FakeShopifyAdmin`) — aucun appel réseau, aucun `fetch` remplacé.
import { hashWebhookTokenSecret, parseWebhookToken } from '@/lib/ingestion/webhook-token';
import { readWebhookToken, rotateWebhookToken } from '@/lib/ingestion/webhook-token-provisioning';
import { ShopifyGraphQLHttpError } from '@/lib/shopify/graphql';
import { getValidShopAccessToken } from '@/lib/shopify/token';
import { acquireShopifyTokenLease, releaseShopifyTokenLease } from '@/lib/shopify/token-lease';
import { INGEST_PATH_PREFIX } from '@/lib/shopify/webhook-subscription-inventory';
import {
  type WebhookReconcileDeps,
  reconcileShopifyWebhookSubscriptions,
} from '@/lib/shopify/webhook-subscription-reconcile';
import { PER_SHOP_SUBSCRIPTION_TOPICS } from '@/lib/shopify/webhook-subscription-topics';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type Admin,
  FakeShopifyAdmin,
  type SeededShop,
  TEST_WEBHOOK_BASE_URL,
  type Tenant,
  cleanupDomains,
  cleanupTenants,
  closePg,
  createTenant,
  freshDomain,
  gate,
  hasStack,
  installShopifyNetworkGuard,
  pg,
  seedConnectedShop,
  service,
} from '../helpers/shopify-webhooks-1b';

const APP = 'wps1b-reconcile-app-sentinel';
const APP_CONFIG = { clientId: APP, clientSecret: 'synthetic-test-client-secret-unused' };
const TOPIC_COUNT = PER_SHOP_SUBSCRIPTION_TOPICS.length;

let tenant: Tenant;
let removeNetworkGuard: () => void = () => undefined;

type Mode = 'installation' | 'repair';

function deps(fake: FakeShopifyAdmin): WebhookReconcileDeps {
  return {
    graphql: fake.graphql,
    getAccessToken: getValidShopAccessToken,
    monotonicNow: () => performance.now(),
  };
}

function reconcile(shop: SeededShop, fake: FakeShopifyAdmin, mode: Mode, admin: Admin = service()) {
  return reconcileShopifyWebhookSubscriptions(
    admin,
    { shopId: shop.shopId, app: APP_CONFIG, mode, webhookBaseUrl: TEST_WEBHOOK_BASE_URL },
    deps(fake),
  );
}

async function setup(label: string) {
  const domain = freshDomain(label);
  const shop = await seedConnectedShop(tenant, domain, { clientId: APP });
  return { shop, fake: new FakeShopifyAdmin(domain) };
}

async function tokenRow(connectionId: string) {
  const { rows } = await (await pg()).query(
    `select public_id, secret_hash, previous_secret_hash, previous_secret_expires_at, revoked_at
       from public.store_connection_webhook_token where store_connection_id = $1`,
    [connectionId],
  );
  return rows[0] as
    | {
        public_id: string;
        secret_hash: string;
        previous_secret_hash: string | null;
        previous_secret_expires_at: Date | null;
        revoked_at: Date | null;
      }
    | undefined;
}

type StateRow = {
  topic: string;
  status: string;
  shopify_subscription_id: string | null;
  token_public_id: string;
  api_version: string | null;
  last_error_code: string | null;
  last_observed_at: string | null;
};

async function stateRows(connectionId: string): Promise<Map<string, StateRow>> {
  const { rows } = await (await pg()).query(
    `select topic, status, shopify_subscription_id, token_public_id, api_version,
            last_error_code, last_observed_at::text as last_observed_at
       from public.shopify_webhook_subscription_state where store_connection_id = $1`,
    [connectionId],
  );
  return new Map((rows as StateRow[]).map((row) => [row.topic, row]));
}

async function leaseRow(connectionId: string) {
  const { rows } = await (await pg()).query(
    `select generation::int as generation, lease_expires_at
       from public.shopify_webhook_reconcile_lease where store_connection_id = $1`,
    [connectionId],
  );
  return rows[0] as { generation: number; lease_expires_at: Date | null } | undefined;
}

// Simule l'écoulement du TTL : le bail tenu devient reprenable, sans être libéré.
async function expireLease(connectionId: string) {
  await (await pg()).query(
    `update public.shopify_webhook_reconcile_lease
        set lease_expires_at = now() - interval '1 second'
      where store_connection_id = $1`,
    [connectionId],
  );
}

function secretHashOfUri(uri: string): string {
  const parsed = parseWebhookToken(new URL(uri).pathname.slice(INGEST_PATH_PREFIX.length));
  if (!parsed) throw new Error('uri sans jeton');
  return hashWebhookTokenSecret(parsed.secret);
}

function expectOneSubscriptionPerTopic(fake: FakeShopifyAdmin) {
  for (const topic of PER_SHOP_SUBSCRIPTION_TOPICS) {
    expect(fake.byTopic(topic.graphql), topic.rest).toHaveLength(1);
  }
  expect(fake.subscriptions).toHaveLength(TOPIC_COUNT);
}

beforeAll(async () => {
  if (!hasStack) return;
  removeNetworkGuard = installShopifyNetworkGuard();
  tenant = await createTenant('wps1b-reconcile');
}, 60_000);

afterEach(cleanupDomains);

afterAll(async () => {
  await closePg();
  await cleanupTenants();
  removeNetworkGuard();
});

describe('installation — première réconciliation', () => {
  it.skipIf(!hasStack)(
    'crée les neuf abonnements, app/uninstalled compris, sur une seule uri, et consigne l’état',
    async () => {
      const { shop, fake } = await setup('install');

      const result = await reconcile(shop, fake, 'installation');

      expect(result).toMatchObject({ ok: true, rotated: true, created: TOPIC_COUNT });
      expectOneSubscriptionPerTopic(fake);
      expect(fake.byTopic('APP_UNINSTALLED')).toHaveLength(1);
      expect(new Set(fake.subscriptions.map((s) => s.uri)).size).toBe(1);

      const token = await tokenRow(shop.connectionId);
      const uri = fake.subscriptions[0].uri;
      expect(
        uri.startsWith(`${TEST_WEBHOOK_BASE_URL}${INGEST_PATH_PREFIX}${token?.public_id}.`),
      ).toBe(true);
      expect(secretHashOfUri(uri)).toBe(token?.secret_hash);

      const states = await stateRows(shop.connectionId);
      expect(states.size).toBe(TOPIC_COUNT);
      for (const topic of PER_SHOP_SUBSCRIPTION_TOPICS) {
        const state = states.get(topic.rest);
        expect(state?.status).toBe('active');
        expect(state?.shopify_subscription_id).toBe(fake.byTopic(topic.graphql)[0].id);
        expect(state?.token_public_id).toBe(token?.public_id);
        // G12 : la version d'API est relue sur l'abonnement créé et consignée.
        expect(state?.api_version).toBe('2026-04');
      }

      // Libération fencée : le bail est rendu.
      expect((await leaseRow(shop.connectionId))?.lease_expires_at).toBeNull();
    },
  );

  it.skipIf(!hasStack)('aucune colonne d’état ne porte l’uri ni le secret', async () => {
    const { shop, fake } = await setup('install-no-secret');
    await reconcile(shop, fake, 'installation');
    const secret = parseWebhookToken(
      new URL(fake.subscriptions[0].uri).pathname.slice(INGEST_PATH_PREFIX.length),
    )?.secret;

    const { rows } = await (await pg()).query(
      `select row_to_json(s)::text as line from public.shopify_webhook_subscription_state s
          where store_connection_id = $1`,
      [shop.connectionId],
    );

    expect(secret).toBeTruthy();
    for (const row of rows as Array<{ line: string }>) {
      expect(row.line).not.toContain(secret as string);
      expect(row.line).not.toContain(INGEST_PATH_PREFIX);
    }
  });
});

describe('choix du mode de rotation (C1), exercé par la réconciliation', () => {
  it.skipIf(!hasStack)(
    'finalisation avec inventaire vide et jeton existant → rotation SANS grâce',
    async () => {
      const { shop, fake } = await setup('mode-install-empty');
      await reconcile(shop, fake, 'installation');
      const before = await tokenRow(shop.connectionId);
      // Réinstallation : Shopify a supprimé tous les abonnements de la boutique.
      fake.subscriptions = [];

      const result = await reconcile(shop, fake, 'installation');

      expect(result).toMatchObject({ ok: true, rotated: true, rotationMode: 'installation' });
      const after = await tokenRow(shop.connectionId);
      expect(after?.public_id).toBe(before?.public_id);
      expect(after?.secret_hash).not.toBe(before?.secret_hash);
      expect(after?.previous_secret_hash).toBeNull();
      expect(after?.previous_secret_expires_at).toBeNull();
      expectOneSubscriptionPerTopic(fake);
    },
  );

  it.skipIf(!hasStack)(
    'finalisation avec un abonnement sur l’empreinte précédente → bascule en réparation, AVEC grâce',
    async () => {
      const { shop, fake } = await setup('mode-install-previous');
      await reconcile(shop, fake, 'installation');
      const original = await tokenRow(shop.connectionId);
      // Les abonnements en place deviennent « précédents » : le jeton a tourné sans eux.
      const read = await readWebhookToken(service(), shop.connectionId);
      if (!read.ok || !read.row) throw new Error('jeton');
      await rotateWebhookToken(service(), { row: read.row, mode: 'repair' });
      const oldIds = fake.subscriptions.map((s) => s.id);

      const result = await reconcile(shop, fake, 'installation');

      expect(result).toMatchObject({
        ok: true,
        rotated: true,
        rotationMode: 'repair',
        created: TOPIC_COUNT,
        deletedPrevious: TOPIC_COUNT,
      });
      const after = await tokenRow(shop.connectionId);
      // L'empreinte encore en service chez Shopify pendant la création reste en grâce.
      expect(after?.previous_secret_hash).toBe(original?.secret_hash);
      expect(after?.previous_secret_expires_at).not.toBeNull();
      expectOneSubscriptionPerTopic(fake);
      for (const id of oldIds) {
        expect(fake.subscriptions.map((s) => s.id)).not.toContain(id);
      }
    },
  );

  it.skipIf(!hasStack)(
    'finalisation avec un abonnement non reconnu vers notre origine → réparation, AVEC grâce',
    async () => {
      const { shop, fake } = await setup('mode-install-foreign');
      await reconcile(shop, fake, 'installation');
      const original = await tokenRow(shop.connectionId);
      fake.subscriptions = [];
      const unknown = fake.seed(
        'ORDERS_CREATE',
        `${TEST_WEBHOOK_BASE_URL}${INGEST_PATH_PREFIX}${original?.public_id}.synthetic-test-unknown`,
      );

      const result = await reconcile(shop, fake, 'installation');

      expect(result).toMatchObject({ ok: true, rotationMode: 'repair', foreign: 1 });
      expect((await tokenRow(shop.connectionId))?.previous_secret_hash).toBe(original?.secret_hash);
      // E10 : un abonnement non reconnu est signalé, jamais supprimé.
      expect(fake.subscriptions.map((s) => s.id)).toContain(unknown.id);
      expect(fake.count('delete')).toBe(0);
    },
  );

  it.skipIf(!hasStack)('réparation → toujours avec grâce, même inventaire vide', async () => {
    const { shop, fake } = await setup('mode-repair');
    await reconcile(shop, fake, 'installation');
    const original = await tokenRow(shop.connectionId);
    fake.subscriptions = [];

    const result = await reconcile(shop, fake, 'repair');

    expect(result).toMatchObject({ ok: true, rotated: true, rotationMode: 'repair' });
    const after = await tokenRow(shop.connectionId);
    expect(after?.previous_secret_hash).toBe(original?.secret_hash);
    expect(after?.previous_secret_expires_at).not.toBeNull();
  });

  it.skipIf(!hasStack)(
    'jeton révoqué (libération d’identité) : rotation, revoked_at à NULL, aucune grâce',
    async () => {
      const { shop, fake } = await setup('mode-revoked');
      await reconcile(shop, fake, 'installation');
      await (await pg()).query(
        'update public.store_connection_webhook_token set revoked_at = now() where store_connection_id = $1',
        [shop.connectionId],
      );

      const result = await reconcile(shop, fake, 'repair');

      expect(result).toMatchObject({ ok: true, rotated: true });
      const after = await tokenRow(shop.connectionId);
      expect(after?.revoked_at).toBeNull();
      expect(after?.previous_secret_hash).toBeNull();
    },
  );
});

describe('W2 — topic manquant', () => {
  it.skipIf(!hasStack)(
    'recréé avec l’uri courante, SANS rotation ; aucun abonnement valide supprimé (E10)',
    async () => {
      const { shop, fake } = await setup('w2');
      await reconcile(shop, fake, 'installation');
      const before = await tokenRow(shop.connectionId);
      const uri = fake.subscriptions[0].uri;
      const survivors = fake.subscriptions.filter((s) => s.topic !== 'ORDERS_UPDATED');
      fake.subscriptions = [...survivors];
      fake.calls = [];

      const result = await reconcile(shop, fake, 'repair');

      expect(result).toMatchObject({
        ok: true,
        rotated: false,
        rotationMode: null,
        created: 1,
        deletedPrevious: 0,
      });
      expect((await tokenRow(shop.connectionId))?.secret_hash).toBe(before?.secret_hash);
      expectOneSubscriptionPerTopic(fake);
      expect(fake.byTopic('ORDERS_UPDATED')[0].uri).toBe(uri);
      expect(fake.calls.filter((call) => call.op === 'create')).toEqual([
        { op: 'create', topic: 'ORDERS_UPDATED' },
      ]);
      expect(fake.count('delete')).toBe(0);
      for (const survivor of survivors) {
        expect(fake.subscriptions.map((s) => s.id)).toContain(survivor.id);
      }
      expect(
        (await stateRows(shop.connectionId)).get('orders/updated')?.shopify_subscription_id,
      ).toBe(fake.byTopic('ORDERS_UPDATED')[0].id);
    },
  );

  it.skipIf(!hasStack)(
    'contrôle positif : inventaire complet → aucun appel de mutation',
    async () => {
      const { shop, fake } = await setup('w2-noop');
      await reconcile(shop, fake, 'installation');
      fake.calls = [];

      const result = await reconcile(shop, fake, 'repair');

      expect(result).toMatchObject({ ok: true, rotated: false, created: 0, deletedPrevious: 0 });
      expect(fake.calls).toEqual([{ op: 'list' }]);
    },
  );

  it.skipIf(!hasStack)(
    'inventaire paginé : un abonnement courant au-delà de la première page est reconnu',
    async () => {
      const { shop, fake } = await setup('w2-paged');
      await reconcile(shop, fake, 'installation');
      const before = await tokenRow(shop.connectionId);
      fake.pageSizeCap = 2;
      fake.calls = [];

      const result = await reconcile(shop, fake, 'repair');

      expect(result).toMatchObject({ ok: true, rotated: false, created: 0 });
      expect(fake.count('list')).toBe(Math.ceil(TOPIC_COUNT / 2));
      expect((await tokenRow(shop.connectionId))?.secret_hash).toBe(before?.secret_hash);
    },
  );
});

describe('W3 — interruption après la création chez Shopify, avant la sauvegarde locale', () => {
  // Client dont toute opération échoue une fois le processus « interrompu ».
  function crashableAdmin() {
    const admin = service();
    const state = { crashed: false };
    const originalFrom = admin.from.bind(admin);
    const originalRpc = admin.rpc.bind(admin);
    const guard = () => {
      if (state.crashed) throw new Error('processus interrompu');
    };
    (admin as unknown as { from: (...args: unknown[]) => unknown }).from = (...args: unknown[]) => {
      guard();
      return (originalFrom as (...inner: unknown[]) => unknown)(...args);
    };
    (admin as unknown as { rpc: (...args: unknown[]) => unknown }).rpc = (...args: unknown[]) => {
      guard();
      return (originalRpc as (...inner: unknown[]) => unknown)(...args);
    };
    return { admin, state };
  }

  async function interruptedInstall(label: string) {
    const { shop, fake } = await setup(label);
    const { admin, state } = crashableAdmin();
    let creations = 0;
    fake.afterCreate = () => {
      creations += 1;
      // Trois abonnements existent chez Shopify ; l'état local du troisième n'est jamais écrit.
      if (creations === 3) state.crashed = true;
    };

    await reconcile(shop, fake, 'installation', admin).catch(() => undefined);
    fake.afterCreate = null;

    expect(fake.subscriptions).toHaveLength(3);
    // Le bail n'a pas été rendu : il s'éteint à son TTL.
    await expireLease(shop.connectionId);
    return { shop, fake, hashAfterCrash: (await tokenRow(shop.connectionId))?.secret_hash };
  }

  it.skipIf(!hasStack)(
    'la reprise reconnaît les abonnements par leur empreinte : AUCUNE nouvelle rotation',
    async () => {
      const { shop, fake, hashAfterCrash } = await interruptedInstall('w3');
      const interruptedTopic = fake.subscriptions[2].topic;
      const interruptedId = fake.subscriptions[2].id;
      const stateBefore = await stateRows(shop.connectionId);
      const restOfInterrupted = PER_SHOP_SUBSCRIPTION_TOPICS.find(
        (t) => t.graphql === interruptedTopic,
      )?.rest as string;
      // L'intention avait été consignée avant l'appel ; la confirmation, jamais.
      expect(stateBefore.get(restOfInterrupted)?.status).toBe('pending');

      const result = await reconcile(shop, fake, 'installation');

      // Compte des rotations : zéro. Le secret est celui d'avant l'interruption.
      expect(result).toMatchObject({ ok: true, rotated: false, created: TOPIC_COUNT - 3 });
      expect((await tokenRow(shop.connectionId))?.secret_hash).toBe(hashAfterCrash);
      expectOneSubscriptionPerTopic(fake);
      expect(new Set(fake.subscriptions.map((s) => s.uri)).size).toBe(1);
      const state = (await stateRows(shop.connectionId)).get(restOfInterrupted);
      expect(state?.status).toBe('active');
      expect(state?.shopify_subscription_id).toBe(interruptedId);
    },
  );

  it.skipIf(!hasStack)(
    'contrôle positif : si Shopify n’a gardé aucun abonnement, la reprise tourne le jeton',
    async () => {
      const { shop, fake, hashAfterCrash } = await interruptedInstall('w3-positive');
      fake.subscriptions = [];

      const result = await reconcile(shop, fake, 'installation');

      expect(result).toMatchObject({ ok: true, rotated: true, created: TOPIC_COUNT });
      expect((await tokenRow(shop.connectionId))?.secret_hash).not.toBe(hashAfterCrash);
    },
  );
});

describe('W1 — finalisation, rejeu, puis réconciliations concurrentes', () => {
  it.skipIf(!hasStack)(
    'rejeu de la finalisation : un seul ensemble d’abonnements, aucune mutation de plus',
    async () => {
      const { shop, fake } = await setup('w1-replay');
      await reconcile(shop, fake, 'installation');
      const ids = fake.subscriptions.map((s) => s.id).sort();
      fake.calls = [];

      const replay = await reconcile(shop, fake, 'installation');

      expect(replay).toMatchObject({ ok: true, rotated: false, created: 0 });
      expect(fake.subscriptions.map((s) => s.id).sort()).toEqual(ids);
      expect(fake.calls).toEqual([{ op: 'list' }]);
    },
  );

  it.skipIf(!hasStack)(
    'trois réconciliations concurrentes (finalisation, relance, cron) sur un topic manquant : UNE création',
    async () => {
      for (let round = 0; round < 3; round += 1) {
        const { shop, fake } = await setup(`w1-concurrent-${round}`);
        await reconcile(shop, fake, 'installation');
        fake.subscriptions = fake.subscriptions.filter((s) => s.topic !== 'ORDERS_CREATE');
        fake.calls = [];
        // Élargit la fenêtre : sans bail, les trois passes liraient le même inventaire.
        fake.afterList = () => new Promise((resolve) => setTimeout(resolve, 150));

        const results = await Promise.all([
          reconcile(shop, fake, 'installation', service()),
          reconcile(shop, fake, 'repair', service()),
          reconcile(shop, fake, 'repair', service()),
        ]);

        expect(results.some((result) => result.ok)).toBe(true);
        for (const result of results) {
          if (!result.ok) expect(result.reason).toBe('lease_held');
        }
        expectOneSubscriptionPerTopic(fake);
        expect(fake.calls.filter((call) => call.op === 'create')).toHaveLength(1);
      }
    },
  );

  it.skipIf(!hasStack)(
    'trois réconciliations concurrentes sur une boutique neuve : neuf abonnements, une seule rotation',
    async () => {
      const { shop, fake } = await setup('w1-concurrent-fresh');
      fake.afterList = () => new Promise((resolve) => setTimeout(resolve, 150));

      const results = await Promise.all([
        reconcile(shop, fake, 'installation', service()),
        reconcile(shop, fake, 'repair', service()),
        reconcile(shop, fake, 'repair', service()),
      ]);

      expect(results.filter((result) => result.ok && result.rotated)).toHaveLength(1);
      expectOneSubscriptionPerTopic(fake);
      expect(new Set(fake.subscriptions.map((s) => s.uri)).size).toBe(1);
    },
  );

  it.skipIf(!hasStack)(
    'aucun blocage du bail des jetons : il reste acquérable PENDANT la réconciliation',
    async () => {
      const { shop, fake } = await setup('w1-token-lease');
      let tokenLeaseAcquired = false;
      fake.afterList = async () => {
        const lease = await acquireShopifyTokenLease(service(), shop.domain);
        tokenLeaseAcquired = lease.ok;
        if (lease.ok) await releaseShopifyTokenLease(service(), shop.domain, lease.generation);
      };

      const result = await reconcile(shop, fake, 'installation');

      expect(result.ok).toBe(true);
      expect(tokenLeaseAcquired).toBe(true);
    },
  );

  it.skipIf(!hasStack)(
    'réciproque : un bail de jetons TENU ne bloque pas la réconciliation (jeton non expirant)',
    async () => {
      const { shop, fake } = await setup('w1-token-lease-held');
      const held = await acquireShopifyTokenLease(service(), shop.domain);
      expect(held.ok).toBe(true);

      const result = await reconcile(shop, fake, 'installation');

      expect(result.ok).toBe(true);
      if (held.ok) await releaseShopifyTokenLease(service(), shop.domain, held.generation);
    },
  );
});

describe('W13 — fencing des ÉCRITURES de la réconciliation', () => {
  // Ancien propriétaire arrêté dans son appel de création ; son bail expire.
  async function staleOwner(label: string) {
    const { shop, fake } = await setup(label);
    await reconcile(shop, fake, 'installation');
    fake.subscriptions = fake.subscriptions.filter((s) => s.topic !== 'ORDERS_CREATE');
    fake.calls = [];

    const barrier = gate();
    let first = true;
    fake.beforeCreate = async () => {
      if (!first) return;
      first = false;
      barrier.reach();
      await barrier.wait();
    };
    const oldOwner = reconcile(shop, fake, 'repair', service());
    await barrier.reached;
    return { shop, fake, barrier, oldOwner };
  }

  it.skipIf(!hasStack)(
    'retour tardif de l’ancien appel Shopify : l’état du nouveau propriétaire n’est pas écrasé, aucun abonnement supprimé',
    async () => {
      const { shop, fake, barrier, oldOwner } = await staleOwner('w13-state');
      await expireLease(shop.connectionId);

      // Nouveau propriétaire : reprend le bail, recrée le topic, consigne son état.
      const newOwner = await reconcile(shop, fake, 'repair', service());
      expect(newOwner).toMatchObject({ ok: true, created: 1 });
      const newOwnerSubscription = fake.byTopic('ORDERS_CREATE')[0];
      const stateOfNewOwner = (await stateRows(shop.connectionId)).get('orders/create');
      expect(stateOfNewOwner?.shopify_subscription_id).toBe(newOwnerSubscription.id);
      const idsOfNewOwner = fake.subscriptions.map((s) => s.id);

      // Retour tardif : l'appel de l'ancien propriétaire aboutit chez Shopify.
      barrier.open();
      const late = await oldOwner;

      expect(late).toEqual({ ok: false, reason: 'lease_lost' });
      const stateAfter = (await stateRows(shop.connectionId)).get('orders/create');
      expect(stateAfter?.shopify_subscription_id).toBe(newOwnerSubscription.id);
      expect(stateAfter?.status).toBe('active');
      expect(stateAfter?.last_observed_at).toBe(stateOfNewOwner?.last_observed_at);
      // Aucun abonnement du nouveau propriétaire n'a disparu, et rien n'a été supprimé.
      expect(fake.count('delete')).toBe(0);
      for (const id of idsOfNewOwner) {
        expect(fake.subscriptions.map((s) => s.id)).toContain(id);
      }
      // Le bail du nouveau propriétaire n'a pas été libéré par l'ancien (libération fencée).
      expect((await leaseRow(shop.connectionId))?.lease_expires_at).toBeNull();
    },
  );

  it.skipIf(!hasStack)(
    'contrôle positif : sans reprise du bail, le même retour tardif écrit l’état',
    async () => {
      const { shop, fake, barrier, oldOwner } = await staleOwner('w13-state-positive');

      barrier.open();
      const result = await oldOwner;

      expect(result).toMatchObject({ ok: true, created: 1 });
      expect(
        (await stateRows(shop.connectionId)).get('orders/create')?.shopify_subscription_id,
      ).toBe(fake.byTopic('ORDERS_CREATE')[0].id);
    },
  );

  // Propriétaire en rotation de réparation, arrêté après sa dernière création : il lui reste à
  // supprimer les neuf abonnements sur l'empreinte précédente.
  async function ownerBeforeCleanup(label: string) {
    const { shop, fake } = await setup(label);
    await reconcile(shop, fake, 'installation');
    const read = await readWebhookToken(service(), shop.connectionId);
    if (!read.ok || !read.row) throw new Error('jeton');
    const previousHash = read.row.secretHash;
    await rotateWebhookToken(service(), { row: read.row, mode: 'repair' });
    const previousIds = fake.subscriptions.map((s) => s.id);
    fake.calls = [];

    const barrier = gate();
    let creations = 0;
    fake.afterCreate = async () => {
      creations += 1;
      if (creations !== TOPIC_COUNT) return;
      barrier.reach();
      await barrier.wait();
    };
    const owner = reconcile(shop, fake, 'repair', service());
    await barrier.reached;
    return { shop, fake, barrier, owner, previousIds, previousHash };
  }

  it.skipIf(!hasStack)(
    'bail repris avant les suppressions : l’ancien propriétaire ne supprime RIEN chez Shopify',
    async () => {
      const { shop, fake, barrier, owner, previousIds } = await ownerBeforeCleanup('w13-delete');
      // Reprise du bail par un autre détenteur (génération + 1), qui n'a encore rien écrit.
      await expireLease(shop.connectionId);
      const { error } = await service().rpc('acquire_shopify_webhook_reconcile_lease', {
        p_store_connection_id: shop.connectionId,
        p_ttl_seconds: 60,
      });
      expect(error).toBeNull();

      barrier.open();
      const late = await owner;

      expect(late).toEqual({ ok: false, reason: 'lease_lost' });
      expect(fake.count('delete')).toBe(0);
      for (const id of previousIds) {
        expect(fake.subscriptions.map((s) => s.id)).toContain(id);
      }
    },
  );

  it.skipIf(!hasStack)(
    'contrôle positif : bail toujours tenu → les neuf abonnements précédents sont supprimés',
    async () => {
      const { fake, barrier, owner, previousIds } = await ownerBeforeCleanup('w13-delete-positive');

      barrier.open();
      const result = await owner;

      expect(result).toMatchObject({ ok: true, deletedPrevious: TOPIC_COUNT });
      for (const id of previousIds) {
        expect(fake.subscriptions.map((s) => s.id)).not.toContain(id);
      }
    },
  );

  it.skipIf(!hasStack)(
    'une suppression ne vise jamais un abonnement redevenu COURANT au moment de la revérification',
    async () => {
      const { shop, fake, barrier, owner, previousIds, previousHash } =
        await ownerBeforeCleanup('w13-delete-current');
      // Entre l'inventaire et la suppression, l'empreinte « précédente » redevient la courante
      // (jeton réécrit par ailleurs). Le bail, lui, est toujours tenu.
      await (await pg()).query(
        `update public.store_connection_webhook_token
            set secret_hash = $2, previous_secret_hash = null, previous_secret_expires_at = null
          where store_connection_id = $1`,
        [shop.connectionId, previousHash],
      );

      barrier.open();
      const result = await owner;

      expect(result).toMatchObject({ ok: true, deletedPrevious: 0 });
      expect(fake.count('delete')).toBe(0);
      for (const id of previousIds) {
        expect(fake.subscriptions.map((s) => s.id)).toContain(id);
      }
    },
  );
});

describe('échec observable et relançable (E4)', () => {
  it.skipIf(!hasStack)(
    'un topic refusé par Shopify : état failed avec son code, précédents conservés, relance convergente',
    async () => {
      const { shop, fake } = await setup('fail-topic');
      fake.failCreateTopics.add('REFUNDS_CREATE');

      const result = await reconcile(shop, fake, 'installation');

      expect(result).toEqual({ ok: false, reason: 'subscription_create_failed' });
      const failed = (await stateRows(shop.connectionId)).get('refunds/create');
      expect(failed?.status).toBe('failed');
      expect(failed?.last_error_code).toBe('shopify_user_error');
      expect(fake.subscriptions).toHaveLength(TOPIC_COUNT - 1);
      const hash = (await tokenRow(shop.connectionId))?.secret_hash;

      fake.failCreateTopics.clear();
      const retried = await reconcile(shop, fake, 'repair');

      expect(retried).toMatchObject({ ok: true, rotated: false, created: 1 });
      expect((await tokenRow(shop.connectionId))?.secret_hash).toBe(hash);
      expectOneSubscriptionPerTopic(fake);
      const repaired = (await stateRows(shop.connectionId)).get('refunds/create');
      expect(repaired?.status).toBe('active');
      expect(repaired?.last_error_code).toBeNull();
    },
  );

  it.skipIf(!hasStack)(
    'WEBHOOK_PUBLIC_BASE_URL absente ou inutilisable : refus nommé, aucun appel, aucune écriture',
    async () => {
      const { shop, fake } = await setup('no-base-url');

      for (const webhookBaseUrl of [undefined, 'http://synthetic-test.example.test', '']) {
        const result = await reconcileShopifyWebhookSubscriptions(
          service(),
          { shopId: shop.shopId, app: APP_CONFIG, mode: 'installation', webhookBaseUrl },
          deps(fake),
        );
        expect(result).toEqual({ ok: false, reason: 'base_url_unavailable' });
      }
      expect(fake.calls).toEqual([]);
      expect(await tokenRow(shop.connectionId)).toBeUndefined();
      expect(await leaseRow(shop.connectionId)).toBeUndefined();
    },
  );

  it.skipIf(!hasStack)(
    'connexion inactive, ou rattachée à une autre app : refus avant tout appel Shopify',
    async () => {
      const inactiveDomain = freshDomain('conn-inactive');
      const inactive = await seedConnectedShop(tenant, inactiveDomain, {
        clientId: APP,
        connectionStatus: 'uninstalled',
      });
      const inactiveFake = new FakeShopifyAdmin(inactiveDomain);
      expect(await reconcile(inactive, inactiveFake, 'repair')).toEqual({
        ok: false,
        reason: 'connection_unavailable',
      });
      expect(inactiveFake.calls).toEqual([]);

      const { shop, fake } = await setup('conn-other-app');
      const result = await reconcileShopifyWebhookSubscriptions(
        service(),
        {
          shopId: shop.shopId,
          app: { clientId: 'wps1b-other-app-sentinel', clientSecret: 'synthetic-test-unused' },
          mode: 'repair',
          webhookBaseUrl: TEST_WEBHOOK_BASE_URL,
        },
        deps(fake),
      );
      expect(result).toEqual({ ok: false, reason: 'connection_unavailable' });
      expect(fake.calls).toEqual([]);
    },
  );
});

describe('non-régression KOBA — app custom, jeton non expirant', () => {
  it.skipIf(!hasStack)('réconcilie sans rafraîchissement ni bail de jetons', async () => {
    const { shop, fake } = await setup('koba');
    const { rows: before } = await (await pg()).query(
      'select access_token_encrypted, access_token_expires_at, refresh_token_encrypted from public.shop where id = $1',
      [shop.shopId],
    );
    expect(before[0].access_token_expires_at).toBeNull();
    expect(before[0].refresh_token_encrypted).toBeNull();

    const result = await reconcile(shop, fake, 'repair');

    expect(result).toMatchObject({ ok: true, created: TOPIC_COUNT });
    const { rows: after } = await (await pg()).query(
      'select access_token_encrypted, access_token_expires_at, refresh_token_encrypted from public.shop where id = $1',
      [shop.shopId],
    );
    expect(after[0]).toEqual(before[0]);
    const { rows: lease } = await (await pg()).query(
      'select 1 from public.shopify_token_lease where shop_domain = $1',
      [shop.domain],
    );
    expect(lease).toHaveLength(0);
  });

  it.skipIf(!hasStack)(
    'un 401 de Shopify ne déclenche ni boucle ni rafraîchissement : un seul appel, échec nommé',
    async () => {
      const { shop, fake } = await setup('koba-401');
      let calls = 0;
      const unauthorized = {
        ...deps(fake),
        graphql: (async () => {
          calls += 1;
          throw new ShopifyGraphQLHttpError(401);
        }) as unknown as WebhookReconcileDeps['graphql'],
      };

      const result = await reconcileShopifyWebhookSubscriptions(
        service(),
        {
          shopId: shop.shopId,
          app: APP_CONFIG,
          mode: 'repair',
          webhookBaseUrl: TEST_WEBHOOK_BASE_URL,
        },
        unauthorized,
      );

      expect(result).toEqual({ ok: false, reason: 'exception' });
      expect(calls).toBe(1);
      // Le bail de réconciliation est rendu même sur un échec.
      expect((await leaseRow(shop.connectionId))?.lease_expires_at).toBeNull();
    },
  );
});
