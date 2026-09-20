/**
 * SEC-APP-SWITCH-01 — preuve RÉELLE (Postgres + PostgREST, jamais mockée) du compare-and-set
 * qui ferme la bascule d'app silencieuse dans le callback OAuth Shopify.
 *
 * Contexte du défaut : `decideShopOwnership` (lib/shopify/ownership-guard.ts) ne confronte que le
 * LOCATAIRE. Une boutique du même locataire déjà rattachée à une autre app (ex. KOBA) voyait donc
 * son `shopify_client_id` et ses jetons chiffrés écrasés par une installation d'une autre app.
 * Le correctif pose deux protections distinctes dans app/api/shopify/callback/route.ts :
 *   1. `decideShopAppSwitch` AVANT `exchangeCodeForToken` — couvert par le test unitaire de route
 *      (tests/unit/shopify-callback-ownership-guard.test.ts) ;
 *   2. le compare-and-set de l'écriture — couvert ICI, parce que sa garantie est une propriété de
 *      PostgreSQL et de PostgREST, jamais du code TypeScript qui l'émet. Un harnais en mémoire
 *      pourrait la simuler ; il ne la prouverait pas.
 *
 * Ce fichier exerce donc le PRÉDICAT réel, avec le même client service-role et la même forme de
 * requête que la route (`lib/shopify/app-release-write.ts:210-231` est le précédent du dépôt).
 * L'extraction d'un cœur d'écriture hors de la route est hors périmètre de ce lot.
 */
import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const password = 'mot-de-passe-test-app-switch';
const createdUserIds: string[] = [];
const createdShopDomains: string[] = [];

const skipIfNoServiceRole = !serviceRoleKey ? it.skip : it;

// Deux apps synthétiques — jamais un client_id réel, jamais un secret.
const KOBA_CLIENT_ID = 'sec-app-switch-koba-sentinel';
const PUBLIC_CLIENT_ID = 'sec-app-switch-public-sentinel';
const OTHER_CLIENT_ID = 'sec-app-switch-other-sentinel';

function serviceClient() {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

afterEach(async () => {
  if (!supabaseUrl || !serviceRoleKey) return;
  const service = serviceClient();
  if (createdShopDomains.length > 0) {
    await service.from('shop').delete().in('shop_domain', createdShopDomains);
    createdShopDomains.length = 0;
  }
  await Promise.all(createdUserIds.map((userId) => service.auth.admin.deleteUser(userId)));
  createdUserIds.length = 0;
});

async function createOwner(emailPrefix: string) {
  const service = serviceClient();
  const email = `${emailPrefix}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`user creation failed: ${error?.message}`);
  createdUserIds.push(data.user.id);

  const { data: account, error: accountError } = await service
    .from('merchant_account')
    .select('id')
    .eq('owner_user_id', data.user.id)
    .single();
  if (accountError || !account) {
    throw new Error(`no merchant_account for owner ${data.user.id}`);
  }

  return { userId: data.user.id, merchantAccountId: account.id };
}

/** Le payload d'écriture du callback, à l'identique (app/api/shopify/callback/route.ts). */
function shopWritePayloadFor(clientId: string, marker: string) {
  return {
    shopify_client_id: clientId,
    access_token_encrypted: `access-${marker}`,
    refresh_token_encrypted: `refresh-${marker}`,
    access_token_expires_at: null,
    refresh_token_expires_at: null,
    scopes: `scopes-${marker}`,
    status: 'active',
    uninstalled_at: null,
    updated_at: new Date().toISOString(),
  };
}

async function createShopRow(
  merchantAccountId: string,
  overrides: {
    shopifyClientId?: string | null;
    status?: string;
    accessTokenEncrypted?: string | null;
    refreshTokenEncrypted?: string | null;
  } = {},
) {
  const service = serviceClient();
  const shopDomain = `sec-app-switch-${Date.now()}-${crypto.randomUUID()}.myshopify.com`;
  createdShopDomains.push(shopDomain);

  const { data, error } = await service
    .from('shop')
    .insert({
      merchant_account_id: merchantAccountId,
      shop_domain: shopDomain,
      status: overrides.status ?? 'active',
      shopify_client_id:
        overrides.shopifyClientId === undefined ? KOBA_CLIENT_ID : overrides.shopifyClientId,
      access_token_encrypted:
        overrides.accessTokenEncrypted === undefined
          ? 'access-koba'
          : overrides.accessTokenEncrypted,
      refresh_token_encrypted:
        overrides.refreshTokenEncrypted === undefined
          ? 'refresh-koba'
          : overrides.refreshTokenEncrypted,
      scopes: 'scopes-koba',
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(`shop insert failed: ${error?.message}`);

  return { shopDomain, shop: data };
}

async function readShop(shopId: string) {
  const { data, error } = await serviceClient()
    .from('shop')
    .select(
      'id, shopify_client_id, access_token_encrypted, refresh_token_encrypted, scopes, status',
    )
    .eq('id', shopId)
    .single();
  if (error || !data) throw new Error(`shop read failed: ${error?.message}`);
  return data;
}

describe('SEC-APP-SWITCH-01 — compare-and-set sur shop.shopify_client_id', () => {
  // ── Preuve 1 — zéro ligne SANS erreur, et aucun secret touché ────────────────────────────
  skipIfNoServiceRole(
    'un prédicat d’app non satisfait rend zéro ligne sans erreur, et ne modifie AUCUN secret',
    async () => {
      const owner = await createOwner('sec-app-switch-p1');
      const { shop } = await createShopRow(owner.merchantAccountId);
      const before = await readShop(shop.id);

      // Forme EXACTE de l'écriture du callback, avec l'attendu du compare-and-set volontairement
      // faux (l'app lue aurait changé entre la lecture de garde et l'écriture).
      const { data: updated, error } = await serviceClient()
        .from('shop')
        .update(shopWritePayloadFor(PUBLIC_CLIENT_ID, 'public'))
        .eq('id', shop.id)
        .eq('merchant_account_id', owner.merchantAccountId)
        .eq('shopify_client_id', OTHER_CLIENT_ID)
        .select('id');

      // Le comportement PostgREST : aucune erreur même quand rien n'a été touché. C'est le
      // tableau vide — jamais `error` — qui porte le verdict, et c'est exactement pourquoi la
      // route lit `!updatedShop` plutôt que `updateError`.
      expect(error).toBeNull();
      expect(updated).toEqual([]);

      // Contrôle négatif colonne par colonne : l'identité ET tous les secrets sont intacts.
      const after = await readShop(shop.id);
      expect(after).toEqual(before);
      expect(after.shopify_client_id).toBe(KOBA_CLIENT_ID);
      expect(after.access_token_encrypted).toBe('access-koba');
      expect(after.refresh_token_encrypted).toBe('refresh-koba');
    },
  );

  skipIfNoServiceRole(
    '`.is(col, null)` ne matche pas une ligne portant une app — un NULL attendu ne vaut jamais « n’importe quelle valeur »',
    async () => {
      const owner = await createOwner('sec-app-switch-p1b');
      const { shop } = await createShopRow(owner.merchantAccountId);

      const { data: updated, error } = await serviceClient()
        .from('shop')
        .update(shopWritePayloadFor(PUBLIC_CLIENT_ID, 'public'))
        .eq('id', shop.id)
        .eq('merchant_account_id', owner.merchantAccountId)
        .is('shopify_client_id', null)
        .select('id');

      expect(error).toBeNull();
      expect(updated).toEqual([]);
      expect((await readShop(shop.id)).shopify_client_id).toBe(KOBA_CLIENT_ID);
    },
  );

  // ── Preuve 2 — concurrence RÉELLE : exactement un gagnant ────────────────────────────────
  skipIfNoServiceRole(
    'course réelle — deux écritures concurrentes sur une boutique sans app : exactement une gagne, aucun mélange de secrets',
    async () => {
      const owner = await createOwner('sec-app-switch-p2');
      // État de départ : aucune app rattachée. Les DEUX callbacks concurrents ont donc lu `null`
      // et émettent le même prédicat `.is('shopify_client_id', null)` — c'est la seule fenêtre
      // que la garde préalable ne peut pas couvrir.
      const { shop } = await createShopRow(owner.merchantAccountId, {
        shopifyClientId: null,
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
      });

      const attempt = (clientId: string, marker: string) =>
        serviceClient()
          .from('shop')
          .update(shopWritePayloadFor(clientId, marker))
          .eq('id', shop.id)
          .eq('merchant_account_id', owner.merchantAccountId)
          .is('shopify_client_id', null)
          .select('id');

      const [a, b] = await Promise.all([
        attempt(KOBA_CLIENT_ID, 'koba'),
        attempt(PUBLIC_CLIENT_ID, 'public'),
      ]);

      // Aucune des deux ne remonte d'erreur : le perdant est signalé par zéro ligne.
      expect(a.error).toBeNull();
      expect(b.error).toBeNull();

      const rowCounts = [a.data?.length ?? 0, b.data?.length ?? 0].sort();
      expect(rowCounts).toEqual([0, 1]);

      // L'identité ET tous les secrets appartiennent au MÊME gagnant — jamais un panachage.
      const after = await readShop(shop.id);
      const winnerMarker = after.shopify_client_id === KOBA_CLIENT_ID ? 'koba' : 'public';
      expect([KOBA_CLIENT_ID, PUBLIC_CLIENT_ID]).toContain(after.shopify_client_id);
      expect(after.access_token_encrypted).toBe(`access-${winnerMarker}`);
      expect(after.refresh_token_encrypted).toBe(`refresh-${winnerMarker}`);
      expect(after.scopes).toBe(`scopes-${winnerMarker}`);

      // Et aucune valeur du perdant n'a survécu, sur aucune colonne du payload.
      const loserMarker = winnerMarker === 'koba' ? 'public' : 'koba';
      expect(after.access_token_encrypted).not.toBe(`access-${loserMarker}`);
      expect(after.refresh_token_encrypted).not.toBe(`refresh-${loserMarker}`);
      expect(after.scopes).not.toBe(`scopes-${loserMarker}`);
    },
  );

  // ── Preuve 3 — CONTRÔLE POSITIF : la bascule voulue reste possible ───────────────────────
  skipIfNoServiceRole(
    'contrôle positif — KOBA → libération d’identité → rattachement d’une autre app réussit',
    async () => {
      const owner = await createOwner('sec-app-switch-p3');
      // 1. Boutique liée à KOBA, désinstallée et sans jeton : la précondition exacte de la
      //    libération (lib/shopify/app-release-guard.ts).
      const { shop } = await createShopRow(owner.merchantAccountId, {
        status: 'uninstalled',
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
      });
      expect((await readShop(shop.id)).shopify_client_id).toBe(KOBA_CLIENT_ID);

      // 2. La libération réelle (RPC de 0155, réservée à service_role) réussit.
      const { data: released, error: releaseError } = await serviceClient().rpc(
        'release_shopify_shop_app_identity',
        { p_user_id: owner.userId, p_shop_id: shop.id, p_old_client_id: KOBA_CLIENT_ID },
      );
      expect(releaseError).toBeNull();
      expect(released).toBe('released');

      // 3. L'identité d'app est retombée à NULL — l'état que la garde doit ACCUEILLIR.
      expect((await readShop(shop.id)).shopify_client_id).toBeNull();

      // 4. Le compare-and-set du callback, avec le prédicat `.is(col, null)` que la route
      //    construit dans cet état, rend bien UNE ligne.
      const { data: updated, error } = await serviceClient()
        .from('shop')
        .update(shopWritePayloadFor(PUBLIC_CLIENT_ID, 'public'))
        .eq('id', shop.id)
        .eq('merchant_account_id', owner.merchantAccountId)
        .is('shopify_client_id', null)
        .select('id');

      expect(error).toBeNull();
      expect(updated).toHaveLength(1);

      // 5. L'identité et tous les jetons sont ceux de la nouvelle app.
      const after = await readShop(shop.id);
      expect(after.shopify_client_id).toBe(PUBLIC_CLIENT_ID);
      expect(after.access_token_encrypted).toBe('access-public');
      expect(after.refresh_token_encrypted).toBe('refresh-public');
      expect(after.status).toBe('active');
    },
  );
});
