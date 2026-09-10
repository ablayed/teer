import type { ResolvedShopContext } from '@/lib/ingestion/canonical';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

export async function resolveShopContext(
  supabase: AdminClient,
  input: { merchantAccountId: string; shopId: string },
): Promise<{ ok: true; context: ResolvedShopContext } | { ok: false }> {
  const { data, error } = await supabase
    .from('shop')
    .select('id, merchant_account_id')
    .eq('id', input.shopId)
    .eq('merchant_account_id', input.merchantAccountId)
    .maybeSingle();

  if (error || !data) {
    return { ok: false };
  }

  return {
    ok: true,
    context: {
      merchantAccountId: data.merchant_account_id,
      shopId: data.id,
    } as unknown as ResolvedShopContext,
  };
}
