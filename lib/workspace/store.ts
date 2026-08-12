import { createSupabaseServerClient } from '@/lib/supabase/server';
import { headers } from 'next/headers';

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

export async function getWorkspaceStores(): Promise<WorkspaceStore[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('list_my_stores');

  if (error || !data) {
    return [];
  }

  return (data as StoreRpcRow[]).map(mapStore);
}

export async function getRequestStoreId(): Promise<string | null> {
  const requestHeaders = await headers();
  return requestHeaders.get('x-teer-store-id');
}

export function defaultWorkspaceStore(stores: WorkspaceStore[]): WorkspaceStore | null {
  return stores.find((store) => store.isDefault) ?? stores[0] ?? null;
}
