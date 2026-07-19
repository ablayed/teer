import { deriveBundleAvailabilities } from '@/lib/products/bundle-availability';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

// Charge product_bundle_component + product_stock DES COMPOSANTS (jamais celui
// du bundle) pour un ensemble de bundles, puis délègue le calcul à la fonction
// pure deriveBundleAvailabilities. Isolé ici (plutôt que dupliqué dans
// lib/actions/products.ts et lib/actions/stock.ts) pour n'avoir qu'un seul
// endroit qui sache comment charger ces deux tables.
export async function resolveBundleAvailabilities(
  admin: SupabaseClient<Database>,
  merchantAccountId: string,
  bundleProductIds: string[],
): Promise<Map<string, number | null>> {
  if (bundleProductIds.length === 0) return new Map();

  const { data: compositionRows } = await admin
    .from('product_bundle_component')
    .select('bundle_product_id, component_product_id, quantity')
    .eq('merchant_account_id', merchantAccountId)
    .in('bundle_product_id', bundleProductIds);

  const rows = compositionRows ?? [];
  const componentIds = [...new Set(rows.map((r) => r.component_product_id))];

  const { data: componentStocks } =
    componentIds.length > 0
      ? await admin
          .from('product_stock')
          .select('product_id, qty_on_hand, qty_reserved')
          .eq('merchant_account_id', merchantAccountId)
          .in('product_id', componentIds)
      : { data: [] };

  const stockByComponentId = new Map(
    (componentStocks ?? []).map((s) => [
      s.product_id,
      { productId: s.product_id, qtyOnHand: s.qty_on_hand, qtyReserved: s.qty_reserved },
    ]),
  );

  return deriveBundleAvailabilities(
    rows.map((r) => ({
      bundleProductId: r.bundle_product_id,
      componentProductId: r.component_product_id,
      quantity: r.quantity,
    })),
    stockByComponentId,
  );
}
