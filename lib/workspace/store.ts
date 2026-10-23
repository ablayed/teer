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

type BootstrapMemberRow = {
  merchant_account_id: string;
  role: 'owner' | 'manager' | 'agent';
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

export type AppBootstrap = {
  stores: WorkspaceStore[];
  member: BootstrapMemberRow | null;
  account: { id: string; onboarded_at: string | null } | null;
};

type AppBootstrapRpcPayload = {
  stores: StoreRpcRow[];
  member: AppBootstrap['member'];
  account: AppBootstrap['account'];
};

// Une seule lecture RPC (get_app_bootstrap, 0168) pour la mise en page : boutiques, membre et compte,
// sous la RLS de l'utilisateur. Mémoïsée par requête (même motif que getCachedDashboardContext) : le
// layout ET getRequestStoreId ont besoin des boutiques sur le même rendu, et valider l'identifiant de
// boutique de l'URL ne doit pas coûter un second aller-retour.
// Une erreur de lecture est levée, jamais réduite à une liste vide (règle 15 de CLAUDE.md).
export const getAppBootstrap = cache(async (): Promise<AppBootstrap> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('get_app_bootstrap');

  if (error) throw new Error(error.message);
  if (!data) throw new Error('App bootstrap unavailable');

  const payload = data as unknown as AppBootstrapRpcPayload;
  return {
    stores: payload.stores.map(mapStore),
    member: payload.member,
    account: payload.account,
  };
});

// La mémoïsation par requête partage le bootstrap entre le layout et la validation des pages.
export const getWorkspaceStores = cache(
  async (): Promise<WorkspaceStore[]> => (await getAppBootstrap()).stores,
);

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
