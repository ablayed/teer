import { resolveConnectionForWebhook } from '@/lib/ingestion/resolve-connection';
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
