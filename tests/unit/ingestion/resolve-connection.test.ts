import {
  finalizeResolvedConnection,
  resolveConnectionByToken,
  resolveConnectionForWebhook,
} from '@/lib/ingestion/resolve-connection';
import { generateWebhookToken, hashWebhookTokenSecret } from '@/lib/ingestion/webhook-token';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

type StoreConnectionRow = {
  id: string;
  merchant_account_id: string;
  shop_id: string;
  platform: string;
  platform_app_id: string | null;
  status: string;
};

function fakeAdmin(response: {
  data: StoreConnectionRow | null;
  error: { message: string } | null;
}) {
  const admin = {
    from: (table: string) => {
      if (table !== 'store_connection') {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => response,
            }),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient<Database>;
  return admin;
}

const CONNECTION_ROW: StoreConnectionRow = {
  id: 'sc-1',
  merchant_account_id: 'ma-1',
  shop_id: 'shop-1',
  platform: 'shopify',
  platform_app_id: 'app-a',
  status: 'active',
};

describe('Lot L2 — resolveConnectionForWebhook', () => {
  it('preuve #2 : connexion inconnue → refus explicite', async () => {
    const admin = fakeAdmin({ data: null, error: null });
    const result = await resolveConnectionForWebhook(
      admin,
      { platformAppId: 'app-a', externalConnectionId: 'unknown.myshopify.com', payload: null },
      { platform: 'shopify' },
    );
    expect(result).toEqual({ ok: false, reason: 'unknown_connection' });
  });

  it("preuve #3 : recoupement d'app effectif — HMAC validé par A, connexion trouvée porte B → refus", async () => {
    const admin = fakeAdmin({ data: CONNECTION_ROW, error: null });
    const result = await resolveConnectionForWebhook(
      admin,
      { platformAppId: 'app-b', externalConnectionId: 'shop.myshopify.com', payload: null },
      { platform: 'shopify' },
    );
    expect(result).toEqual({ ok: false, reason: 'app_mismatch' });
  });

  it('connexion sans platform_app_id enregistré → refus (jamais un laissez-passer)', async () => {
    const admin = fakeAdmin({ data: { ...CONNECTION_ROW, platform_app_id: null }, error: null });
    const result = await resolveConnectionForWebhook(
      admin,
      { platformAppId: 'app-a', externalConnectionId: 'shop.myshopify.com', payload: null },
      { platform: 'shopify' },
    );
    expect(result).toEqual({ ok: false, reason: 'app_mismatch' });
  });

  it('contrôle positif : app validée == platform_app_id de la connexion trouvée → résolu', async () => {
    const admin = fakeAdmin({ data: CONNECTION_ROW, error: null });
    const result = await resolveConnectionForWebhook(
      admin,
      { platformAppId: 'app-a', externalConnectionId: 'shop.myshopify.com', payload: null },
      { platform: 'shopify' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.storeConnectionId).toBe('sc-1');
      expect(result.context.merchantAccountId).toBe('ma-1');
      expect(result.context.shopId).toBe('shop-1');
    }
  });
});

// Mutation-testing (preuve #3, exécuté manuellement en session — voir rapport) : en retirant le
// bloc `if (!data.platform_app_id || data.platform_app_id !== verified.platformAppId)` de
// lib/ingestion/resolve-connection.ts, le test "recoupement d'app effectif" ci-dessus passe au
// ROUGE avec `{ ok: true, ... }` au lieu du refus attendu — la connexion B est acceptée à tort
// avec l'app A. Fonction restaurée immédiatement après, diff vide vérifié.

// ============================================================================
// Lot L3 (périmètre réduit) — resolveConnectionByToken / finalizeResolvedConnection
// ============================================================================

type TokenRow = {
  secret_hash: string;
  previous_secret_hash: string | null;
  previous_secret_expires_at: string | null;
  revoked_at: string | null;
  store_connection_id: string;
};

type ConnectionRow = {
  id: string;
  merchant_account_id: string;
  shop_id: string;
  platform: string;
  platform_app_id: string | null;
  external_identifier: string;
  status: string;
};

function fakeTokenAdmin({
  tokenRow,
  connectionRow,
}: {
  tokenRow: TokenRow | null;
  connectionRow: ConnectionRow | null;
}) {
  const admin = {
    from: (table: string) => {
      if (table === 'store_connection_webhook_token') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: tokenRow, error: null }),
            }),
          }),
        };
      }
      if (table === 'store_connection') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: connectionRow, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
  return admin;
}

const TOKEN = generateWebhookToken();

const TOKEN_ROW: TokenRow = {
  secret_hash: TOKEN.secretHash,
  previous_secret_hash: null,
  previous_secret_expires_at: null,
  revoked_at: null,
  store_connection_id: 'sc-1',
};

const CONNECTION_ROW_L3: ConnectionRow = {
  id: 'sc-1',
  merchant_account_id: 'ma-1',
  shop_id: 'shop-1',
  platform: 'shopify',
  platform_app_id: 'app-a',
  external_identifier: 'shop.myshopify.com',
  status: 'active',
};

describe('Lot L3 — resolveConnectionByToken', () => {
  it('preuve #4 (jeton malformé) : pas de séparateur → refus, aucune requête émise', async () => {
    const admin = {
      from: () => {
        throw new Error('ne devrait jamais être appelé pour un jeton malformé');
      },
    } as unknown as SupabaseClient<Database>;
    const result = await resolveConnectionByToken(admin, 'not-a-valid-token');
    expect(result).toEqual({ ok: false, reason: 'malformed_token' });
  });

  it('preuve #4 (jeton inconnu) : public_id absent en base → refus', async () => {
    const admin = fakeTokenAdmin({ tokenRow: null, connectionRow: null });
    const result = await resolveConnectionByToken(admin, TOKEN.raw);
    expect(result).toEqual({ ok: false, reason: 'unknown_token' });
  });

  it('jeton révoqué → refus, même avec le bon secret', async () => {
    const admin = fakeTokenAdmin({
      tokenRow: { ...TOKEN_ROW, revoked_at: new Date().toISOString() },
      connectionRow: CONNECTION_ROW_L3,
    });
    const result = await resolveConnectionByToken(admin, TOKEN.raw);
    expect(result).toEqual({ ok: false, reason: 'revoked' });
  });

  it('preuve #4 (mauvais secret) : secret différent → refus', async () => {
    const admin = fakeTokenAdmin({ tokenRow: TOKEN_ROW, connectionRow: CONNECTION_ROW_L3 });
    const other = generateWebhookToken();
    const result = await resolveConnectionByToken(admin, `${TOKEN.publicId}.${other.secret}`);
    expect(result).toEqual({ ok: false, reason: 'secret_mismatch' });
  });

  it('preuve #7 (rotation, fenêtre ouverte) : ancien secret encore accepté', async () => {
    const previous = generateWebhookToken();
    const admin = fakeTokenAdmin({
      tokenRow: {
        ...TOKEN_ROW,
        previous_secret_hash: hashWebhookTokenSecret(previous.secret),
        previous_secret_expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      connectionRow: CONNECTION_ROW_L3,
    });
    const result = await resolveConnectionByToken(admin, `${TOKEN.publicId}.${previous.secret}`);
    expect(result.ok).toBe(true);
  });

  it('preuve #7 (rotation, fenêtre expirée) : ancien secret refusé après échéance', async () => {
    const previous = generateWebhookToken();
    const admin = fakeTokenAdmin({
      tokenRow: {
        ...TOKEN_ROW,
        previous_secret_hash: hashWebhookTokenSecret(previous.secret),
        previous_secret_expires_at: new Date(Date.now() - 1_000).toISOString(),
      },
      connectionRow: CONNECTION_ROW_L3,
    });
    const result = await resolveConnectionByToken(admin, `${TOKEN.publicId}.${previous.secret}`);
    expect(result).toEqual({ ok: false, reason: 'secret_expired' });
  });

  it("preuve #7 : jamais deux secrets valides indéfiniment — le secret COURANT reste valide pendant la fenêtre de l'ancien", async () => {
    const admin = fakeTokenAdmin({
      tokenRow: {
        ...TOKEN_ROW,
        previous_secret_hash: hashWebhookTokenSecret(generateWebhookToken().secret),
        previous_secret_expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      connectionRow: CONNECTION_ROW_L3,
    });
    const result = await resolveConnectionByToken(admin, TOKEN.raw);
    expect(result.ok).toBe(true);
  });

  it('connexion inactive (uninstalled) → refus même avec un jeton valide', async () => {
    const admin = fakeTokenAdmin({
      tokenRow: TOKEN_ROW,
      connectionRow: { ...CONNECTION_ROW_L3, status: 'uninstalled' },
    });
    const result = await resolveConnectionByToken(admin, TOKEN.raw);
    expect(result).toEqual({ ok: false, reason: 'connection_inactive' });
  });

  it('contrôle positif : jeton valide + connexion active → résolu, aucun champ secret exposé', async () => {
    const admin = fakeTokenAdmin({ tokenRow: TOKEN_ROW, connectionRow: CONNECTION_ROW_L3 });
    const result = await resolveConnectionByToken(admin, TOKEN.raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection).toEqual({
        storeConnectionId: 'sc-1',
        merchantAccountId: 'ma-1',
        shopId: 'shop-1',
        platform: 'shopify',
        platformAppId: 'app-a',
        externalIdentifier: 'shop.myshopify.com',
      });
    }
  });
});

describe('Lot L3 — finalizeResolvedConnection', () => {
  const connection = {
    storeConnectionId: 'sc-1',
    merchantAccountId: 'ma-1',
    shopId: 'shop-1',
    platform: 'shopify',
    platformAppId: 'app-a',
    externalIdentifier: 'shop.myshopify.com',
  };

  it('preuve #3 : jeton de la connexion B, app validante = A → refus (désaccord app/jeton)', () => {
    const result = finalizeResolvedConnection(connection, { clientId: 'app-b' });
    expect(result).toEqual({ ok: false, reason: 'app_mismatch' });
  });

  it('platform_app_id absent (jamais backfillé) → refus, jamais un laissez-passer', () => {
    const result = finalizeResolvedConnection(
      { ...connection, platformAppId: null },
      {
        clientId: 'app-a',
      },
    );
    expect(result).toEqual({ ok: false, reason: 'app_mismatch' });
  });

  it('preuve #2 (routage à app égale) : app validante == platform_app_id → résolu', () => {
    const result = finalizeResolvedConnection(connection, { clientId: 'app-a' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.storeConnectionId).toBe('sc-1');
      expect(result.context.shopId).toBe('shop-1');
    }
  });
});

// Mutation-testing (preuve #3, Lot L3) : en retirant la condition de finalizeResolvedConnection,
// le test "désaccord app/jeton" ci-dessus passe au ROUGE (`{ ok: true }` au lieu du refus attendu).
// Fonction restaurée immédiatement après, diff vide vérifié.
