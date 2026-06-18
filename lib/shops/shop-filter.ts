import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

export type ShopFilterOption = {
  id: string;
  label: string;
};

export function normalizeShopParam(
  value: string | null | undefined,
  shops: ShopFilterOption[],
): string | null {
  if (!value || value === 'all') {
    return null;
  }

  return shops.some((shop) => shop.id === value) ? value : null;
}

export async function listShopFilterOptions(
  supabase: Pick<SupabaseClient<Database>, 'from'>,
  merchantAccountId: string,
): Promise<ShopFilterOption[]> {
  const { data, error } = await supabase
    .from('shop')
    .select('id, shop_domain')
    .eq('merchant_account_id', merchantAccountId)
    .order('installed_at', { ascending: true });

  if (error) {
    return [];
  }

  return (data ?? []).map((shop) => ({
    id: shop.id,
    label: shop.shop_domain,
  }));
}
