// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C4 — finalisation (branche 1 de D16b et POST de rattachement) :
// la réconciliation des abonnements a lieu APRÈS `store_connection` et APRÈS la libération du bail
// des jetons, et son échec ne défait jamais le rattachement.
//
// Couche : RLS/intégration. Les vraies primitives de 0160/0161 décident ; la réconciliation est
// un espion qui RELÈVE l'état de la base au moment où elle est appelée — c'est cet état, lu dans
// PostgreSQL, qui prouve l'ordre.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type Tenant,
  cleanupDomains,
  cleanupTenants,
  closePg,
  createTenant,
  ensureTestEncryptionKey,
  freshDomain,
  hasStack,
  installShopifyNetworkGuard,
  pg,
  service,
} from '../helpers/shopify-webhooks-1b';

const APP = 'wps1b-callpoints-app-sentinel';
const APP_CONFIG = {
  clientId: APP,
  clientSecret: 'synthetic-test-client-secret-unused',
  distribution: 'public' as const,
};

let tenant: Tenant;
let removeNetworkGuard: () => void = () => undefined;

type Observation = {
  input: { shopId: string; app: { clientId: string } };
  tokenLeaseHeld: boolean;
  connectionStatus: string | null;
  shopStatus: string | null;
};

// Espion : relève, dans la base, ce qui est vrai à l'instant où la réconciliation est appelée.
function reconcileSpy(domain: string, result: boolean) {
  const observations: Observation[] = [];
  const reconcileWebhooks = async (
    _admin: unknown,
    input: { shopId: string; app: { clientId: string } },
  ) => {
    const client = await pg();
    const lease = await client.query(
      'select lease_expires_at from public.shopify_token_lease where shop_domain = $1',
      [domain],
    );
    const connection = await client.query(
      `select status from public.store_connection
        where platform = 'shopify' and external_identifier = $1`,
      [domain],
    );
    const shop = await client.query('select status from public.shop where shop_domain = $1', [
      domain,
    ]);
    observations.push({
      input,
      tokenLeaseHeld: Boolean(lease.rows[0]?.lease_expires_at),
      connectionStatus: (connection.rows[0]?.status as string | undefined) ?? null,
      shopStatus: (shop.rows[0]?.status as string | undefined) ?? null,
    });
    return result;
  };
  return { observations, reconcileWebhooks };
}

const exchangeCode = (async () => ({
  accessToken: `synthetic-test-access-${crypto.randomUUID()}`,
  refreshToken: `synthetic-test-refresh-${crypto.randomUUID()}`,
  scope: 'read_orders',
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
  refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
})) as never;

async function authorize(
  domain: string,
  reconcileWebhooks: ReturnType<typeof reconcileSpy>['reconcileWebhooks'],
) {
  const { performNoSessionAuthorization } = await import('@/lib/shopify/no-session-authorization');
  return performNoSessionAuthorization(
    service(),
    { shopDomain: domain, app: APP_CONFIG, code: 'authorization-code' },
    { exchangeCode, syncProducts: async () => true, reconcileWebhooks },
  );
}

async function claim(
  ticket: string,
  reconcileWebhooks: ReturnType<typeof reconcileSpy>['reconcileWebhooks'],
) {
  const { performShopifyClaim } = await import('@/lib/shopify/claim-core');
  return performShopifyClaim(
    service(),
    {
      ticket,
      userId: tenant.userId,
      merchantAccountId: tenant.merchantAccountId,
      resolveApp: (clientId) => (clientId === APP ? APP_CONFIG : null),
    },
    { syncProducts: async () => true, reconcileWebhooks },
  );
}

async function shopId(domain: string): Promise<string | null> {
  const { rows } = await (await pg()).query('select id from public.shop where shop_domain = $1', [
    domain,
  ]);
  return (rows[0]?.id as string | undefined) ?? null;
}

beforeAll(async () => {
  if (!hasStack) return;
  ensureTestEncryptionKey();
  removeNetworkGuard = installShopifyNetworkGuard();
  tenant = await createTenant('wps1b-callpoints');
}, 60_000);

afterEach(cleanupDomains);

afterAll(async () => {
  await closePg();
  await cleanupTenants();
  removeNetworkGuard();
});

describe('POST de rattachement (consommation d’un ticket)', () => {
  it.skipIf(!hasStack)(
    'réconcilie après store_connection et après la libération du bail des jetons',
    async () => {
      const domain = freshDomain('claim');
      const idle = reconcileSpy(domain, true);
      const pending = await authorize(domain, idle.reconcileWebhooks);
      if (pending.kind !== 'pending') throw new Error(`attendu : pending, reçu ${pending.kind}`);
      // Branche 2 : aucune boutique rattachée, donc aucune réconciliation.
      expect(idle.observations).toEqual([]);

      const spy = reconcileSpy(domain, true);
      const outcome = await claim(pending.ticket, spy.reconcileWebhooks);

      expect(outcome).toEqual({ kind: 'connected', syncPending: false });
      expect(spy.observations).toHaveLength(1);
      expect(spy.observations[0]).toMatchObject({
        input: { shopId: await shopId(domain), app: { clientId: APP } },
        tokenLeaseHeld: false,
        connectionStatus: 'active',
        shopStatus: 'active',
      });
    },
  );

  it.skipIf(!hasStack)(
    'un échec de la réconciliation ne défait pas le rattachement : connectée, sync=pending',
    async () => {
      const domain = freshDomain('claim-fail');
      const pending = await authorize(domain, reconcileSpy(domain, true).reconcileWebhooks);
      if (pending.kind !== 'pending') throw new Error('pending attendu');

      const outcome = await claim(pending.ticket, reconcileSpy(domain, false).reconcileWebhooks);

      expect(outcome).toEqual({ kind: 'connected', syncPending: true });
      const { rows } = await (await pg()).query(
        'select status, access_token_encrypted is not null as has_token from public.shop where shop_domain = $1',
        [domain],
      );
      expect(rows[0]).toEqual({ status: 'active', has_token: true });
    },
  );
});

describe('branche 1 de D16b (boutique déjà installée, callback sans locataire)', () => {
  async function installed(label: string) {
    const domain = freshDomain(label);
    const pending = await authorize(domain, reconcileSpy(domain, true).reconcileWebhooks);
    if (pending.kind !== 'pending') throw new Error('pending attendu');
    await claim(pending.ticket, reconcileSpy(domain, true).reconcileWebhooks);
    return domain;
  }

  it.skipIf(!hasStack)(
    'réconcilie après store_connection et après la libération du bail des jetons',
    async () => {
      const domain = await installed('branch1');
      const spy = reconcileSpy(domain, true);

      const result = await authorize(domain, spy.reconcileWebhooks);

      expect(result).toEqual({ kind: 'arrived', syncPending: false });
      expect(spy.observations).toHaveLength(1);
      expect(spy.observations[0]).toMatchObject({
        input: { shopId: await shopId(domain), app: { clientId: APP } },
        tokenLeaseHeld: false,
        connectionStatus: 'active',
      });
    },
  );

  it.skipIf(!hasStack)(
    'un échec de la réconciliation : arrivée conservée, sync=pending, boutique toujours active',
    async () => {
      const domain = await installed('branch1-fail');

      const result = await authorize(domain, reconcileSpy(domain, false).reconcileWebhooks);

      expect(result).toEqual({ kind: 'arrived', syncPending: true });
      const { rows } = await (await pg()).query(
        'select status from public.shop where shop_domain = $1',
        [domain],
      );
      expect(rows[0]?.status).toBe('active');
    },
  );
});
