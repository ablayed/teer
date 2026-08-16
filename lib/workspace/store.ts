import { createSupabaseServerClient } from '@/lib/supabase/server';
import { headers } from 'next/headers';
import { cache } from 'react';

export type WorkspaceStore = {
  id: string;
  merchantAccountId: string;
  displayName: string;
  shopDomain: string;
  storeKind: 'manual' | 'shopify';
  status: string;
  isDefault: boolean;
  role: 'owner' | 'manager' | 'agent';
};

type StoreRpcRow = {
  id: string;
  merchant_account_id: string;
  display_name: string;
  shop_domain: string;
  store_kind: 'manual' | 'shopify';
  status: string;
  is_default: boolean;
  role: 'owner' | 'manager' | 'agent';
};

type LegacyMemberRow = {
  merchant_account_id: string;
  role: 'owner' | 'manager' | 'agent';
};

type LegacyShopRow = {
  id: string;
  merchant_account_id: string;
  shop_domain: string;
  status: string;
  installed_at: string;
};

type WorkspaceShopEnrichment = {
  id: string;
  display_name: string;
  store_kind: 'manual' | 'shopify';
  is_default: boolean;
};

function mapStore(row: StoreRpcRow): WorkspaceStore {
  return {
    displayName: row.display_name,
    id: row.id,
    isDefault: row.is_default,
    merchantAccountId: row.merchant_account_id,
    role: row.role,
    shopDomain: row.shop_domain,
    status: row.status,
    storeKind: row.store_kind,
  };
}

// 0126 is additive, but the RPC is introduced by 0127. This read-only fallback
// keeps the Phase 1 application usable during the migration-first rollout
// window without assuming any Phase 1-only column exists.
async function getLegacyWorkspaceStores(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<WorkspaceStore[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data: members, error: memberError } = await supabase
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', user.id);
  if (memberError || !members || members.length === 0) return [];

  const memberByMerchant = new Map(
    (members as LegacyMemberRow[]).map((member) => [member.merchant_account_id, member.role]),
  );
  const { data: shops, error: shopError } = await supabase
    .from('shop')
    .select('id, merchant_account_id, shop_domain, status, installed_at')
    .in('merchant_account_id', [...memberByMerchant.keys()])
    .order('installed_at', { ascending: true });
  if (shopError || !shops) return [];

  const { data: enrichedShops } = await supabase
    .from('shop')
    .select('id, display_name, store_kind, is_default')
    .in('merchant_account_id', [...memberByMerchant.keys()]);
  const enrichmentById = new Map(
    (enrichedShops as WorkspaceShopEnrichment[] | null | undefined)?.map((shop) => [shop.id, shop]),
  );
  const firstByMerchant = new Set<string>();
  return (shops as LegacyShopRow[]).map((shop) => {
    const enrichment = enrichmentById.get(shop.id);
    const isDefault = enrichment?.is_default ?? !firstByMerchant.has(shop.merchant_account_id);
    firstByMerchant.add(shop.merchant_account_id);
    const isManual = enrichment?.store_kind === 'manual' || shop.shop_domain.endsWith('.internal');
    return {
      displayName: enrichment?.display_name ?? shop.shop_domain,
      id: shop.id,
      isDefault,
      merchantAccountId: shop.merchant_account_id,
      role: memberByMerchant.get(shop.merchant_account_id) ?? 'agent',
      shopDomain: shop.shop_domain,
      status: shop.status,
      storeKind: isManual ? 'manual' : 'shopify',
    };
  });
}

// Request-scoped memoization (même motif que getCachedDashboardContext) : le
// layout ET getRequestStoreId ont besoin de la liste des boutiques sur le même
// rendu. Sans cache, valider l'identifiant de boutique de l'URL coûterait un
// second aller-retour RPC par page.
export const getWorkspaceStores = cache(async (): Promise<WorkspaceStore[]> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('list_my_stores');

  if (error || !data) {
    return getLegacyWorkspaceStores(supabase);
  }

  return (data as StoreRpcRow[]).map(mapStore);
});

export async function getRequestStoreId(): Promise<string | null> {
  const requestHeaders = await headers();
  const requestStoreId = requestHeaders.get('x-teer-store-id');
  const stores = await getWorkspaceStores();

  // Le segment /s/{storeId} est une donnée d'URL : il n'est retenu que s'il
  // désigne réellement une boutique accessible à l'appelant. Un identifiant
  // forgé, révoqué ou appartenant à un autre tenant renvoie null — il n'est
  // jamais propagé aux requêtes de données, et jamais remplacé silencieusement
  // par une autre boutique (AppLayout répond 404 sur ce même cas).
  if (requestStoreId) {
    return stores.find((store) => store.id === requestStoreId)?.id ?? null;
  }

  // URL legacy : rendue en place avec la boutique par défaut du workspace,
  // sans redirection vers /s/{storeId} (cf. AppLayout). L'entrée /s n'a pas
  // d'en-tête de chemin legacy et garde donc son sélecteur explicite dès que
  // le workspace compte plusieurs boutiques.
  if (requestHeaders.get('x-teer-legacy-path')) {
    return defaultWorkspaceStore(stores)?.id ?? null;
  }
  return stores.length === 1 ? stores[0].id : null;
}

export function defaultWorkspaceStore(stores: WorkspaceStore[]): WorkspaceStore | null {
  return stores.find((store) => store.isDefault) ?? stores[0] ?? null;
}
