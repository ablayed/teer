'use server';

import { getMerchantAccount } from '@/lib/actions/merchant';
import { authActionClient } from '@/lib/actions/safe-action';
import { syncShopOrders } from '@/lib/shopify/shop-sync';
import type { Tables } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getRequestStoreId } from '@/lib/workspace/store';

type ShopRow = Tables<'shop'>;
export type ShopConnection = Pick<ShopRow, 'shop_domain' | 'scopes' | 'status' | 'installed_at'>;

export async function getShopConnection(shopId?: string): Promise<ShopConnection | null> {
  const merchantAccount = await getMerchantAccount();

  if (!merchantAccount) {
    return null;
  }

  const supabase = await createSupabaseServerClient();
  // Phase 13 : un marchand multi-boutiques a plusieurs `shop` actifs. On retourne
  // la plus ancienne comme boutique représentative (sert au booléen « a une
  // boutique » et au contrôle de scope) ; `maybeSingle()` lèverait sur 2+ lignes.
  // APP-03/Lot 2 : une boutique `active` sans access_token_encrypted (rattachement embarqué en
  // attente du token exchange) n'est PAS une connexion Shopify exploitable — l'exclure ici pour
  // que l'appelant (/commandes) affiche « aucune boutique » plutôt que « aucune commande » avec un
  // bouton de synchronisation actionnable qui échouerait silencieusement à l'usage.
  let shopQuery = supabase
    .from('shop')
    .select('shop_domain, scopes, status, installed_at')
    .eq('merchant_account_id', merchantAccount.id)
    .eq('store_kind', 'shopify')
    .eq('status', 'active')
    .not('access_token_encrypted', 'is', null);
  if (shopId) shopQuery = shopQuery.eq('id', shopId);
  const { data, error } = await shopQuery
    .order('installed_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export const syncOrdersAction = authActionClient
  .metadata({ actionName: 'shopify.sync_orders', section: 'shopify' })
  .action(async ({ ctx }) => {
    const merchantAccount = await getMerchantAccount();

    if (!merchantAccount) {
      return { ok: false as const, errorCode: 'no_shop' as const };
    }

    const shopId = await getRequestStoreId();
    const result = await syncShopOrders({
      actorUserId: ctx.user.id,
      merchantAccountId: merchantAccount.id,
      shopId: shopId ?? undefined,
    });

    if (!result.ok) {
      return { ok: false as const, errorCode: result.errorCode };
    }

    return { ok: true as const, syncedCount: result.syncedCount };
  });
