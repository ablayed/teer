import { shopifyGraphQL } from '@/lib/shopify/graphql';
import { extractShopifyId } from '@/lib/shopify/orders-sync';
import type { Database, Tables, TablesInsert, TablesUpdate } from '@/lib/supabase/database.types';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

export const SHOPIFY_PRODUCTS_QUERY = `
query Products($cursor: String) {
  products(first: 50, after: $cursor, sortKey: UPDATED_AT, reverse: true) {
    edges {
      cursor
      node {
        id
        title
        status
        variants(first: 50) {
          edges {
            node {
              id
              title
              sku
            }
          }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
`;

export type ShopifyProductVariantNode = {
  id: string;
  title: string | null;
  sku: string | null;
};

export type ShopifyProductNode = {
  id: string;
  title: string;
  status: string | null;
  variants: {
    edges: Array<{
      node: ShopifyProductVariantNode;
    }>;
  };
};

export type ShopifyProductsResponse = {
  products: {
    edges: Array<{
      cursor: string;
      node: ShopifyProductNode;
    }>;
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
};

type ProductTableRow = Tables<'product'>;
type ProductInsert = TablesInsert<'product'>;
type ProductUpdate = TablesUpdate<'product'>;
type AdminClient = SupabaseClient<Database>;

type SyncProductsForShopInput = {
  accessToken: string;
  actorUserId?: string | null;
  admin: AdminClient;
  merchantAccountId: string;
  shop: Pick<Tables<'shop'>, 'id' | 'shop_domain'>;
  auditAction?: 'shopify.products_synced' | 'shop_synced';
};

function logProductSyncError(prefix: string, error: unknown, _payload?: unknown) {
  Sentry.captureException(error, {
    tags: { module: 'shopify.products-sync' },
    extra: { error_code: 'shopify_product_sync_failed', prefix },
  });
}

function displayTitle(productTitle: string, variantTitle: string | null): string {
  if (!variantTitle || variantTitle === 'Default Title') {
    return productTitle;
  }

  return `${productTitle} - ${variantTitle}`;
}

function mapShopifyVariantToProductInsert(
  merchantAccountId: string,
  shopId: string,
  productNode: ShopifyProductNode,
  variantNode: ShopifyProductVariantNode,
): ProductInsert {
  return {
    merchant_account_id: merchantAccountId,
    shop_id: shopId,
    shopify_product_id: extractShopifyId(productNode.id),
    shopify_variant_id: extractShopifyId(variantNode.id),
    sku: variantNode.sku?.trim() || null,
    title: displayTitle(productNode.title, variantNode.title),
    unit_cost: 0,
    is_active: productNode.status?.toUpperCase() === 'ACTIVE',
  };
}

function toProductRecords(
  merchantAccountId: string,
  shopId: string,
  productNodes: ShopifyProductNode[],
): ProductInsert[] {
  return productNodes.flatMap((productNode) =>
    productNode.variants.edges
      .map((edge) => edge.node)
      .filter((variantNode) => Boolean(variantNode.id))
      .map((variantNode) =>
        mapShopifyVariantToProductInsert(merchantAccountId, shopId, productNode, variantNode),
      ),
  );
}

async function persistShopifyProducts({
  merchantAccountId,
  shopId,
  productNodes,
  supabaseServiceClient,
}: {
  merchantAccountId: string;
  shopId: string;
  productNodes: ShopifyProductNode[];
  supabaseServiceClient: AdminClient;
}): Promise<{ ok: true; syncedCount: number } | { ok: false; error: string }> {
  const records = toProductRecords(merchantAccountId, shopId, productNodes);

  if (records.length === 0) {
    return { ok: true, syncedCount: 0 };
  }

  const variantIds = records
    .map((record) => record.shopify_variant_id)
    .filter((value): value is string => Boolean(value));

  const { data: existingProducts, error: existingProductsError } = await supabaseServiceClient
    .from('product')
    .select('id, shopify_variant_id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('shop_id', shopId)
    .in('shopify_variant_id', variantIds);

  if (existingProductsError) {
    return { ok: false, error: existingProductsError.message };
  }

  const existingByVariantId = new Map(
    ((existingProducts ?? []) as Array<Pick<ProductTableRow, 'id' | 'shopify_variant_id'>>)
      .filter((product) => Boolean(product.shopify_variant_id))
      .map((product) => [product.shopify_variant_id as string, product.id]),
  );

  const inserts: ProductInsert[] = [];
  const updates: Array<{ id: string; update: ProductUpdate }> = [];

  for (const record of records) {
    const variantId = record.shopify_variant_id;

    if (!variantId) {
      continue;
    }

    const existingId = existingByVariantId.get(variantId);

    if (existingId) {
      updates.push({
        id: existingId,
        update: {
          shopify_product_id: record.shopify_product_id,
          shopify_variant_id: record.shopify_variant_id,
          sku: record.sku,
          title: record.title,
          is_active: record.is_active,
          updated_at: new Date().toISOString(),
        },
      });
      continue;
    }

    inserts.push(record);
  }

  if (inserts.length > 0) {
    const { error: insertError } = await supabaseServiceClient.from('product').insert(inserts);

    if (insertError) {
      return { ok: false, error: insertError.message };
    }
  }

  for (const item of updates) {
    const { error: updateError } = await supabaseServiceClient
      .from('product')
      .update(item.update)
      .eq('id', item.id);

    if (updateError) {
      return { ok: false, error: updateError.message };
    }
  }

  return { ok: true, syncedCount: records.length };
}

export async function syncProductsForShop({
  accessToken,
  actorUserId = null,
  admin,
  auditAction = 'shopify.products_synced',
  merchantAccountId,
  shop,
}: SyncProductsForShopInput): Promise<
  { ok: true; shopId: string; syncedCount: number } | { ok: false; errorCode: 'sync_failed' }
> {
  try {
    let cursor: string | null = null;
    let syncedCount = 0;
    let failedCount = 0;

    while (true) {
      const data: ShopifyProductsResponse = await shopifyGraphQL<ShopifyProductsResponse>({
        accessToken,
        query: SHOPIFY_PRODUCTS_QUERY,
        shopDomain: shop.shop_domain,
        variables: { cursor },
      });

      const productNodes = data.products.edges.map(
        (edge: ShopifyProductsResponse['products']['edges'][number]) => edge.node,
      );
      const result = await persistShopifyProducts({
        merchantAccountId,
        shopId: shop.id,
        productNodes,
        supabaseServiceClient: admin,
      });

      if (!result.ok) {
        failedCount += productNodes.length;
        logProductSyncError('[sync] product storage failed', result.error, {
          merchantAccountId,
          shopId: shop.id,
        });

        return { ok: false, errorCode: 'sync_failed' };
      }

      syncedCount += result.syncedCount;

      if (!data.products.pageInfo.hasNextPage || !data.products.pageInfo.endCursor) {
        break;
      }

      cursor = data.products.pageInfo.endCursor;
    }

    const { error: auditError } = await admin.from('audit_log').insert({
      action: auditAction,
      actor_user_id: actorUserId,
      merchant_account_id: merchantAccountId,
      payload: { failedCount, syncedCount },
      resource_id: shop.id,
      resource_type: 'shop',
    });

    if (auditError) {
      logProductSyncError('[sync] audit insert failed', auditError, { failedCount, syncedCount });
    }

    return { ok: true, shopId: shop.id, syncedCount };
  } catch (error) {
    logProductSyncError('[sync] sync failed', error, {
      merchantAccountId,
      shopId: shop.id,
    });
    return { ok: false, errorCode: 'sync_failed' };
  }
}

export async function persistShopifyProductWebhook({
  merchantAccountId,
  shopId,
  productNode,
  supabaseServiceClient,
}: {
  merchantAccountId: string;
  shopId: string;
  productNode: ShopifyProductNode;
  supabaseServiceClient: AdminClient;
}): Promise<{ ok: true; syncedCount: number } | { ok: false; error: string }> {
  return persistShopifyProducts({
    merchantAccountId,
    shopId,
    productNodes: [productNode],
    supabaseServiceClient,
  });
}
