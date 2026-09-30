// SHOPIFY-OAUTH-FIRST-01 / R2 — effets APRÈS une persistance réussie des credentials.
//
// Une persistance SQL réussie (branche 1 de D16b, ou consommation en `inserted`/`updated`) VAUT
// rattachement réussi : credentials et audit sont écrits dans la même transaction. Les deux
// effets qui suivent sont idempotents et rejouables ; leur échec est OBSERVÉ (sentinelle
// expurgée) et ne transforme JAMAIS le résultat en échec — ni `connection_failed`, ni bannière
// rouge. L'appelant ajoute `sync=pending` à la page d'arrivée ; `syncShopAction` relance.
//
//   1. `store_connection`, sous le bail de la persistance (écriture fencée par sa génération),
//      AVANT la libération du bail (D11) ;
//   2. synchronisation des produits, APRÈS la libération (D3) : `getValidShopAccessToken` peut
//      reprendre un bail pour rafraîchir, et `runWithShopifyUnauthorizedRetry` rejoue une fois
//      après un 401. Jamais un jeton brut transmis depuis l'échange (modèle lib/shopify/shop-sync.ts).
//
// Module pur de toute dépendance d'environnement : importable par les suites RLS.
import { ShopifyGraphQLHttpError } from '@/lib/shopify/graphql';
import { syncProductsForShop } from '@/lib/shopify/products-sync';
import { getValidShopAccessToken, runWithShopifyUnauthorizedRetry } from '@/lib/shopify/token';
import { writeShopifyStoreConnectionFenced } from '@/lib/shopify/token-lease';
import type { Database } from '@/lib/supabase/database.types';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

export type PostConnectApp = { clientId: string; clientSecret: string };

// Sentinelles expurgées : ni domaine, ni locataire, ni jeton — seul le verdict technique.
export function reportPostConnectEffectFailed(
  effect: 'store_connection' | 'products_sync',
  reason: string,
): void {
  Sentry.captureMessage('shopify_post_connect_effect_failed', {
    level: 'warning',
    tags: { module: 'shopify.post-connect', effect, reason },
  });
}

export async function writeStoreConnectionUnderLease(
  admin: AdminClient,
  input: { shopDomain: string; generation: number; merchantAccountId: string; clientId: string },
): Promise<boolean> {
  try {
    const outcome = await writeShopifyStoreConnectionFenced(admin, input);
    if (outcome !== 'written') {
      reportPostConnectEffectFailed('store_connection', outcome);
      return false;
    }
    return true;
  } catch {
    reportPostConnectEffectFailed('store_connection', 'exception');
    return false;
  }
}

export async function syncProductsAfterConnect(
  admin: AdminClient,
  input: { shopId: string; app: PostConnectApp; actorUserId: string | null },
): Promise<boolean> {
  try {
    const { data: shop, error } = await admin
      .from('shop')
      .select(
        'id, shop_domain, merchant_account_id, access_token_encrypted, refresh_token_encrypted, access_token_expires_at, refresh_token_expires_at',
      )
      .eq('id', input.shopId)
      .maybeSingle();
    if (error || !shop) {
      reportPostConnectEffectFailed('products_sync', 'shop_unreadable');
      return false;
    }

    const token = await getValidShopAccessToken(
      admin,
      shop,
      input.app.clientId,
      input.app.clientSecret,
    );
    if (!token.ok) {
      reportPostConnectEffectFailed('products_sync', token.reason);
      return false;
    }

    const result = await runWithShopifyUnauthorizedRetry(
      admin,
      shop,
      input.app.clientId,
      input.app.clientSecret,
      token.accessToken,
      async (accessToken) => {
        const synced = await syncProductsForShop({
          accessToken,
          actorUserId: input.actorUserId,
          admin,
          merchantAccountId: shop.merchant_account_id,
          shop: { id: shop.id, shop_domain: shop.shop_domain },
        });
        if (!synced.ok && synced.errorCode === 'unauthorized') {
          throw new ShopifyGraphQLHttpError(401);
        }
        return synced;
      },
    );
    if (!result.ok) {
      reportPostConnectEffectFailed('products_sync', result.errorCode);
      return false;
    }
    return true;
  } catch {
    reportPostConnectEffectFailed('products_sync', 'exception');
    return false;
  }
}
