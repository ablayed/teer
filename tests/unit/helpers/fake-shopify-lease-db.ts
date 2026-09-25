// SHOPIFY-EXPIRING-TOKENS-01 — modèle EN MÉMOIRE des RPC de bail (0158) pour les tests unitaires
// des routes qui acquièrent un jeton Shopify. Il reproduit les verdicts de
// `acquire_shopify_token_lease`, `persist_shopify_credentials_fenced` et
// `write_shopify_store_connection_fenced`, et la libération conditionnelle par UPDATE. Le
// comportement RÉEL de ces RPC (verrous, concurrence, ACL) est prouvé contre PostgreSQL par
// tests/rls/schema-token-lease-01.rls.test.ts et tests/rls/shopify-expiring-tokens-01.rls.test.ts ;
// ce modèle ne sert qu'à exercer l'orchestration applicative sans stack Supabase.
//
// Toute écriture DIRECTE sur `shop` ou `store_connection` est enregistrée dans `directWrites` et
// renvoie une erreur : depuis ce lot, un chemin d'acquisition n'en émet plus aucune.

export type FakeShopRow = {
  id: string;
  shop_domain: string;
  merchant_account_id: string;
  shopify_client_id?: string | null;
  status?: string;
  [key: string]: unknown;
};

export type FakeConnectionRow = {
  id: string;
  platform: string;
  external_identifier: string;
  merchant_account_id: string;
  shop_id: string;
  [key: string]: unknown;
};

type Lease = { generation: number; leaseExpiresAt: number | null };

const CANONICAL = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function createState() {
  return {
    shops: [] as FakeShopRow[],
    connections: [] as FakeConnectionRow[],
    leases: new Map<string, Lease>(),
    rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
    directWrites: [] as Array<{ table: string; op: string; payload?: unknown }>,
    otherInserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
    releases: [] as Array<{ shopDomain: unknown; generation: unknown }>,
    // Crochet déclenché après la lecture de garde `shop` par domaine (courses simulées).
    onAfterGuardRead: null as null | (() => void),
    // Crochet déclenché AVANT le traitement d'une RPC (ex. reprise du bail pendant l'appel).
    onBeforeRpc: null as null | ((name: string) => void),
    nextId: 0,
  };
}

export const fakeLeaseDb = {
  state: createState(),

  reset() {
    this.state = createState();
  },

  freshId(prefix: string) {
    this.state.nextId += 1;
    return `${prefix}-${this.state.nextId}`;
  },

  // Bail tenu par un autre détenteur (acquisition refusée).
  holdLease(shopDomain: string, generation = 1) {
    this.state.leases.set(shopDomain, { generation, leaseExpiresAt: Date.now() + 60_000 });
  },

  // Reprise du bail par un autre détenteur (génération + 1), comme une préemption.
  bumpLease(shopDomain: string) {
    const lease = this.state.leases.get(shopDomain) ?? { generation: 0, leaseExpiresAt: null };
    this.state.leases.set(shopDomain, {
      generation: lease.generation + 1,
      leaseExpiresAt: Date.now() + 60_000,
    });
  },

  client() {
    const db = this;
    const state = () => db.state;

    function leaseHeld(domain: string, generation: unknown): boolean {
      const lease = state().leases.get(domain);
      return Boolean(lease && lease.generation === generation && lease.leaseExpiresAt !== null);
    }

    function rpc(name: string, args: Record<string, unknown>) {
      state().onBeforeRpc?.(name);
      state().rpcCalls.push({ name, args });
      const domain = args.p_shop_domain as string;

      if (name === 'acquire_shopify_token_lease') {
        const lease = state().leases.get(domain);
        if (lease && lease.leaseExpiresAt !== null && lease.leaseExpiresAt > Date.now()) {
          return { data: [], error: null };
        }
        const generation = (lease?.generation ?? 0) + 1;
        state().leases.set(domain, { generation, leaseExpiresAt: Date.now() + 60_000 });
        return { data: [{ acquired_generation: generation, expires_at: 'x' }], error: null };
      }

      if (name === 'persist_shopify_credentials_fenced') {
        const mode = args.p_mode as string;
        if (!CANONICAL.test(domain) || !args.p_access_token_encrypted) {
          return { data: [{ outcome: 'invalid_input', shop_id: null }], error: null };
        }
        if (!leaseHeld(domain, args.p_generation)) {
          return { data: [{ outcome: 'lease_lost', shop_id: null }], error: null };
        }
        let shop = state().shops.find((row) => row.shop_domain === domain);
        const credentials = {
          access_token_encrypted: args.p_access_token_encrypted,
          refresh_token_encrypted: args.p_refresh_token_encrypted,
          access_token_expires_at: args.p_access_token_expires_at,
          refresh_token_expires_at: args.p_refresh_token_expires_at,
        };
        if (!shop) {
          if (mode !== 'authorization_code') {
            return { data: [{ outcome: 'shop_not_found', shop_id: null }], error: null };
          }
          shop = {
            id: db.freshId('shop'),
            shop_domain: domain,
            merchant_account_id: args.p_merchant_account_id as string,
            shopify_client_id: args.p_client_id as string,
            ...credentials,
            scopes: args.p_scopes,
            status: 'active',
          };
          state().shops.push(shop);
          return { data: [{ outcome: 'inserted', shop_id: shop.id }], error: null };
        }
        if (shop.merchant_account_id !== args.p_merchant_account_id) {
          return { data: [{ outcome: 'ownership_refused', shop_id: null }], error: null };
        }
        const currentApp = shop.shopify_client_id ?? null;
        if (mode === 'authorization_code') {
          if (currentApp !== null && currentApp !== args.p_client_id) {
            return { data: [{ outcome: 'app_switch_refused', shop_id: null }], error: null };
          }
          Object.assign(shop, credentials, {
            shopify_client_id: args.p_client_id,
            scopes: args.p_scopes,
            status: 'active',
            uninstalled_at: null,
          });
          return { data: [{ outcome: 'updated', shop_id: shop.id }], error: null };
        }
        if (currentApp !== args.p_client_id) {
          return { data: [{ outcome: 'app_identity_mismatch', shop_id: null }], error: null };
        }
        if (mode === 'token_exchange') {
          Object.assign(shop, credentials, { scopes: args.p_scopes, status: 'active' });
          return { data: [{ outcome: 'updated', shop_id: shop.id }], error: null };
        }
        if (shop.status !== 'active') {
          return { data: [{ outcome: 'shop_inactive', shop_id: null }], error: null };
        }
        Object.assign(shop, {
          access_token_encrypted: credentials.access_token_encrypted,
          refresh_token_encrypted:
            credentials.refresh_token_encrypted ?? shop.refresh_token_encrypted,
          access_token_expires_at: credentials.access_token_expires_at,
          refresh_token_expires_at:
            credentials.refresh_token_expires_at ?? shop.refresh_token_expires_at,
        });
        return { data: [{ outcome: 'updated', shop_id: shop.id }], error: null };
      }

      if (name === 'write_shopify_store_connection_fenced') {
        if (!leaseHeld(domain, args.p_generation)) {
          return { data: [{ outcome: 'lease_lost', connection_id: null }], error: null };
        }
        const shop = state().shops.find((row) => row.shop_domain === domain);
        if (!shop) {
          return { data: [{ outcome: 'shop_not_found', connection_id: null }], error: null };
        }
        if (shop.merchant_account_id !== args.p_merchant_account_id) {
          return { data: [{ outcome: 'ownership_refused', connection_id: null }], error: null };
        }
        if ((shop.shopify_client_id ?? null) !== args.p_client_id) {
          return { data: [{ outcome: 'app_identity_mismatch', connection_id: null }], error: null };
        }
        let connection = state().connections.find(
          (row) => row.platform === 'shopify' && row.external_identifier === domain,
        );
        if (connection && connection.merchant_account_id !== shop.merchant_account_id) {
          return { data: [{ outcome: 'ownership_refused', connection_id: null }], error: null };
        }
        if (!connection) {
          connection = {
            id: db.freshId('conn'),
            platform: 'shopify',
            external_identifier: domain,
            merchant_account_id: shop.merchant_account_id,
            shop_id: shop.id,
          };
          state().connections.push(connection);
        }
        Object.assign(connection, {
          shop_id: shop.id,
          platform_app_id: args.p_client_id,
          status: 'active',
          uninstalled_at: null,
        });
        return { data: [{ outcome: 'written', connection_id: connection.id }], error: null };
      }

      return { data: null, error: { message: `rpc non modélisée : ${name}` } };
    }

    function forbiddenWrite(table: string, op: string, payload?: unknown) {
      state().directWrites.push({ table, op, payload });
      const result = { data: null, error: { message: `écriture directe interdite sur ${table}` } };
      const builder: Record<string, unknown> = {};
      for (const method of ['eq', 'is', 'not', 'select']) {
        builder[method] = () => builder;
      }
      builder.single = async () => result;
      builder.maybeSingle = async () => result;
      // biome-ignore lint/suspicious/noThenProperty: thenable délibéré (builder PostgREST awaitable).
      builder.then = (resolve: (value: typeof result) => void) => resolve(result);
      return builder;
    }

    function shopSelect() {
      const filters: Array<[string, unknown]> = [];
      const read = () => {
        const row = state().shops.find((candidate) =>
          filters.every(([column, value]) => (candidate[column] ?? null) === value),
        );
        return row ? { ...row, shopify_client_id: row.shopify_client_id ?? null } : null;
      };
      const builder = {
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        async maybeSingle() {
          const snapshot = read();
          if (filters.some(([column]) => column === 'shop_domain')) {
            const hook = state().onAfterGuardRead;
            state().onAfterGuardRead = null;
            hook?.();
          }
          return { data: snapshot, error: null };
        },
        async single() {
          const snapshot = read();
          return snapshot
            ? { data: snapshot, error: null }
            : { data: null, error: { code: 'PGRST116', message: 'no rows found' } };
        },
      };
      return builder;
    }

    return {
      rpc: async (name: string, args: Record<string, unknown>) => rpc(name, args),
      from(table: string) {
        if (table === 'shop') {
          return {
            select: () => shopSelect(),
            insert: (payload: unknown) => forbiddenWrite(table, 'insert', payload),
            update: (payload: unknown) => forbiddenWrite(table, 'update', payload),
            upsert: (payload: unknown) => forbiddenWrite(table, 'upsert', payload),
          };
        }
        if (table === 'store_connection') {
          return {
            insert: (payload: unknown) => forbiddenWrite(table, 'insert', payload),
            update: (payload: unknown) => forbiddenWrite(table, 'update', payload),
            upsert: (payload: unknown) => forbiddenWrite(table, 'upsert', payload),
          };
        }
        if (table === 'shopify_token_lease') {
          return {
            update: (payload: { lease_expires_at: null }) => {
              const filters: Array<[string, unknown]> = [];
              const builder = {
                eq(column: string, value: unknown) {
                  filters.push([column, value]);
                  return builder;
                },
                async not() {
                  const domain = filters.find(([column]) => column === 'shop_domain')?.[1];
                  const generation = filters.find(([column]) => column === 'generation')?.[1];
                  state().releases.push({ shopDomain: domain, generation });
                  const lease = state().leases.get(domain as string);
                  if (lease && lease.generation === generation && lease.leaseExpiresAt !== null) {
                    lease.leaseExpiresAt = payload.lease_expires_at;
                  }
                  return { error: null };
                },
              };
              return builder;
            },
          };
        }
        return {
          insert: async (payload: Record<string, unknown>) => {
            state().otherInserts.push({ table, payload });
            return { error: null };
          },
        };
      },
    };
  },
};
