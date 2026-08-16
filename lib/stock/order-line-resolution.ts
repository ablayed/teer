import type { Database, Json } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AnySupabaseClient = SupabaseClient<Database>;
type MatchStatus = 'matched' | 'unresolved' | 'ambiguous';

export type ItemsummaryLine = {
  title: string;
  sku?: string | null;
  quantity: number;
  price?: number;
  shopify_variant_id?: string | null;
  shopify_product_id?: string | null;
  product_id?: string | null;
};

export type ResolvedOrderLine = {
  product_id: string | null;
  raw_title: string;
  raw_sku: string | null;
  raw_shopify_variant_id: string | null;
  raw_shopify_product_id: string | null;
  qty: number;
  match_status: MatchStatus;
};

export function parseItemsummary(items: Json): ItemsummaryLine[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (typeof item !== 'object' || !item) return [];
    const i = item as Record<string, unknown>;
    const title = typeof i.title === 'string' ? i.title : '';
    if (!title.trim()) return [];
    return [
      {
        title,
        sku: typeof i.sku === 'string' ? i.sku : null,
        quantity: typeof i.quantity === 'number' ? Math.max(1, i.quantity) : 1,
        price: typeof i.price === 'number' ? i.price : undefined,
        shopify_variant_id: typeof i.shopify_variant_id === 'string' ? i.shopify_variant_id : null,
        shopify_product_id: typeof i.shopify_product_id === 'string' ? i.shopify_product_id : null,
        product_id: typeof i.product_id === 'string' ? i.product_id : null,
      },
    ];
  });
}

export async function resolveOrderLines(
  client: AnySupabaseClient,
  {
    merchantAccountId,
    lineItems,
    shopId,
  }: {
    merchantAccountId: string;
    lineItems: ItemsummaryLine[];
    shopId: string;
  },
): Promise<ResolvedOrderLine[]> {
  if (lineItems.length === 0) return [];

  // Le rapprochement ne doit JAMAIS traverser une frontière de boutique : un SKU
  // homonyme dans une autre boutique du même marchand ferait pointer la ligne
  // vers un produit dont le stock vit ailleurs.
  const { data: products } = await client
    .from('product')
    .select('id, shopify_variant_id, shopify_product_id, sku')
    .eq('merchant_account_id', merchantAccountId)
    .eq('shop_id', shopId)
    .eq('is_active', true);

  const variantMap = new Map<string, string>();
  const shopifyProductMap = new Map<string, string[]>();
  const skuMap = new Map<string, string>();
  const productIdSet = new Set<string>();

  for (const p of products ?? []) {
    productIdSet.add(p.id);
    if (p.shopify_variant_id) variantMap.set(p.shopify_variant_id, p.id);
    if (p.shopify_product_id) {
      const list = shopifyProductMap.get(p.shopify_product_id) ?? [];
      list.push(p.id);
      shopifyProductMap.set(p.shopify_product_id, list);
    }
    if (p.sku) skuMap.set(p.sku.trim().toLowerCase(), p.id);
  }

  function resolve(item: ItemsummaryLine): { productId: string | null; status: MatchStatus } {
    if (item.product_id && productIdSet.has(item.product_id)) {
      return { productId: item.product_id, status: 'matched' };
    }
    if (item.shopify_variant_id) {
      const pid = variantMap.get(item.shopify_variant_id);
      if (pid) return { productId: pid, status: 'matched' };
    }
    if (item.shopify_product_id) {
      const pids = shopifyProductMap.get(item.shopify_product_id) ?? [];
      if (pids.length === 1) return { productId: pids[0] ?? null, status: 'matched' };
      if (pids.length > 1) return { productId: null, status: 'ambiguous' };
    }
    if (item.sku) {
      const pid = skuMap.get(item.sku.trim().toLowerCase());
      if (pid) return { productId: pid, status: 'matched' };
    }
    return { productId: null, status: 'unresolved' };
  }

  return lineItems.map((item) => {
    const { productId, status } = resolve(item);
    return {
      product_id: productId,
      raw_title: item.title.trim(),
      raw_sku: item.sku ?? null,
      raw_shopify_variant_id: item.shopify_variant_id ?? null,
      raw_shopify_product_id: item.shopify_product_id ?? null,
      qty: item.quantity,
      match_status: status,
    };
  });
}

export async function resolveAndInsertOrderLines(
  client: AnySupabaseClient,
  {
    merchantAccountId,
    orderId,
    lineItems,
    shopId,
  }: {
    merchantAccountId: string;
    orderId: string;
    lineItems: ItemsummaryLine[];
    shopId: string;
  },
): Promise<void> {
  const resolvedLines = await resolveOrderLines(client, { merchantAccountId, lineItems, shopId });
  if (resolvedLines.length === 0) return;

  // Boutique héritée de la COMMANDE porteuse : une ligne ne peut pas vivre dans
  // une autre boutique que sa commande.
  const inserts = resolvedLines.map((line) => ({
    merchant_account_id: merchantAccountId,
    shop_id: shopId,
    order_id: orderId,
    ...line,
  }));

  await client.from('order_line').insert(inserts);
}
