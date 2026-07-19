'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { resolveBundleAvailabilities } from '@/lib/products/resolve-bundle-availability';
import type { Database, Tables } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { type TeamRole, isTeamRole } from '@/lib/team/permissions';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

const PRODUCTS_PER_PAGE = 25;

type SupabaseServerClient = SupabaseClient<Database>;
type ProductRow = Tables<'product'>;
export type ProductCatalogItem = Pick<
  ProductRow,
  | 'created_at'
  | 'id'
  | 'is_active'
  | 'shopify_product_id'
  | 'shopify_variant_id'
  | 'sku'
  | 'title'
  | 'updated_at'
> & {
  unit_cost: number | null;
};

type ProductCatalogPageData =
  | {
      ok: true;
      currentRole: TeamRole;
      products: ProductCatalogItem[];
    }
  | {
      ok: false;
      errorCode: 'forbidden' | 'load_failed' | 'unauthenticated';
    };

const productInputSchema = z.object({
  sku: z.string().trim().max(80).optional(),
  title: z.string().trim().min(2).max(160),
  unitCost: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const productUnitCostSchema = z.object({
  productId: z.string().uuid(),
  unitCost: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function asTypedSupabaseClient(client: unknown): SupabaseServerClient {
  return client as SupabaseServerClient;
}

async function getCurrentMember() {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false as const, errorCode: 'unauthenticated' as const };
  }

  const { data: member, error } = await supabase
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  if (error || !member || !isTeamRole(member.role)) {
    return { ok: false as const, errorCode: 'forbidden' as const };
  }

  return {
    ok: true as const,
    member: {
      merchantAccountId: member.merchant_account_id,
      role: member.role,
    },
  };
}

export type ProductsPageItem = {
  id: string;
  title: string;
  sku: string | null;
  unit_cost: number | null;
  is_active: boolean;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  created_at: string;
  updated_at: string;
  qtyOnHand: number;
  qtyReserved: number;
  qtyAvailable: number;
  lowStockThreshold: number;
  isLowStock: boolean;
  stockUnitCost: number | null;
  stockValue: number | null;
  isBundle: boolean;
  bundleAvailability: number | null;
};

type ProductsPageResult =
  | {
      ok: true;
      items: ProductsPageItem[];
      hasMore: boolean;
      nextOffset: number;
      canSeeCost: boolean;
      currentRole: TeamRole;
    }
  | { ok: false; errorCode: string };

export async function getProductsPageData(params: {
  q?: string;
  offset?: number;
}): Promise<ProductsPageResult> {
  const currentMember = await getCurrentMember();
  if (!currentMember.ok) return currentMember;

  const { merchantAccountId, role } = currentMember.member;
  const canSeeCost = role === 'owner' || role === 'manager';
  const offset = params.offset ?? 0;
  const limit = PRODUCTS_PER_PAGE + 1;

  const admin = createSupabaseAdminClient();

  let productQuery = admin
    .from('product')
    .select(
      'id, title, sku, unit_cost, is_active, shopify_product_id, shopify_variant_id, created_at, updated_at, is_bundle',
    )
    .eq('merchant_account_id', merchantAccountId)
    .order('title', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);

  if (params.q?.trim()) {
    const q = params.q.trim();
    productQuery = productQuery.or(`title.ilike.%${q}%,sku.ilike.%${q}%`);
  }

  const { data: productData, error: productError } = await productQuery;
  if (productError) return { ok: false, errorCode: 'load_failed' };

  const hasMore = (productData?.length ?? 0) > PRODUCTS_PER_PAGE;
  const products = hasMore ? productData.slice(0, PRODUCTS_PER_PAGE) : (productData ?? []);
  const productIds = products.map((p) => p.id);

  const { data: stocks } =
    productIds.length > 0
      ? await admin
          .from('product_stock')
          .select('product_id, qty_on_hand, qty_reserved, unit_cost, low_stock_threshold')
          .eq('merchant_account_id', merchantAccountId)
          .in('product_id', productIds)
      : { data: [] };

  const stockMap = new Map((stocks ?? []).map((s) => [s.product_id, s]));

  const bundleIds = products.filter((p) => p.is_bundle).map((p) => p.id);
  const bundleAvailabilityMap = await resolveBundleAvailabilities(
    admin,
    merchantAccountId,
    bundleIds,
  );

  const items: ProductsPageItem[] = products.map((p) => {
    const s = stockMap.get(p.id);
    const qtyOnHand = s?.qty_on_hand ?? 0;
    const qtyReserved = s?.qty_reserved ?? 0;
    const qtyAvailable = Math.max(0, qtyOnHand - qtyReserved);
    const threshold = s?.low_stock_threshold ?? 10;
    return {
      id: p.id,
      title: p.title,
      sku: p.sku,
      unit_cost: canSeeCost ? (p.unit_cost ?? 0) : null,
      is_active: p.is_active,
      shopify_product_id: p.shopify_product_id,
      shopify_variant_id: p.shopify_variant_id,
      created_at: p.created_at,
      updated_at: p.updated_at,
      qtyOnHand,
      qtyReserved,
      qtyAvailable,
      lowStockThreshold: threshold,
      isLowStock: qtyOnHand <= threshold,
      stockUnitCost: canSeeCost ? (s?.unit_cost ?? 0) : null,
      stockValue: canSeeCost ? qtyOnHand * (s?.unit_cost ?? 0) : null,
      isBundle: p.is_bundle,
      bundleAvailability: p.is_bundle ? (bundleAvailabilityMap.get(p.id) ?? null) : null,
    };
  });

  return {
    ok: true,
    items,
    hasMore,
    nextOffset: offset + PRODUCTS_PER_PAGE,
    canSeeCost,
    currentRole: role,
  };
}

export async function getProductCatalogPageData(): Promise<ProductCatalogPageData> {
  const currentMember = await getCurrentMember();

  if (!currentMember.ok) {
    return currentMember;
  }

  const { merchantAccountId, role } = currentMember.member;
  const canReadCosts = role === 'owner' || role === 'manager';

  if (canReadCosts) {
    const admin = createSupabaseAdminClient();
    const { data, error } = await admin
      .from('product')
      .select(
        'id, title, sku, shopify_product_id, shopify_variant_id, unit_cost, is_active, created_at, updated_at',
      )
      .eq('merchant_account_id', merchantAccountId)
      .order('updated_at', { ascending: false });

    if (error) {
      return { ok: false, errorCode: 'load_failed' };
    }

    return {
      ok: true,
      currentRole: role,
      products: ((data ?? []) as ProductCatalogItem[]).map((product) => ({
        ...product,
        unit_cost: product.unit_cost,
      })),
    };
  }

  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const { data, error } = await supabase
    .from('product')
    .select(
      'id, title, sku, shopify_product_id, shopify_variant_id, is_active, created_at, updated_at',
    )
    .eq('merchant_account_id', merchantAccountId)
    .order('updated_at', { ascending: false });

  if (error) {
    return { ok: false, errorCode: 'load_failed' };
  }

  return {
    ok: true,
    currentRole: role,
    products: ((data ?? []) as Array<Omit<ProductCatalogItem, 'unit_cost'>>).map((product) => ({
      ...product,
      unit_cost: null,
    })),
  };
}

export const createProductAction = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'products.create', section: 'products' })
  .inputSchema(productInputSchema)
  .action(async ({ ctx, parsedInput }) => {
    const admin = createSupabaseAdminClient();
    const unitCost = ctx.member.role === 'agent' ? 0 : parsedInput.unitCost;
    const { data, error } = await admin
      .from('product')
      .insert({
        merchant_account_id: ctx.member.merchantAccountId,
        sku: parsedInput.sku?.trim() || null,
        title: parsedInput.title,
        unit_cost: unitCost,
      })
      .select('id, title, sku')
      .single();

    if (error) {
      return { ok: false as const, errorCode: 'create_failed' as const };
    }

    revalidatePath('/produits');

    return {
      ok: true as const,
      product: {
        id: data.id,
        sku: data.sku,
        title: data.title,
      },
    };
  });

export const updateProductUnitCostAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'products.update_unit_cost', section: 'products' })
  .inputSchema(productUnitCostSchema)
  .action(async ({ ctx, parsedInput }) => {
    const admin = createSupabaseAdminClient();
    const { error } = await admin
      .from('product')
      .update({
        unit_cost: parsedInput.unitCost,
        updated_at: new Date().toISOString(),
      })
      .eq('id', parsedInput.productId)
      .eq('merchant_account_id', ctx.member.merchantAccountId);

    if (error) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    revalidatePath('/produits');

    return { ok: true as const };
  });

export const loadMoreProductsAction = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'products.load_more', section: 'products' })
  .inputSchema(
    z.object({
      q: z.string().optional(),
      offset: z.number().int().min(0),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const { merchantAccountId, role } = ctx.member;
    const canSeeCost = role === 'owner' || role === 'manager';
    const limit = PRODUCTS_PER_PAGE + 1;

    const admin = createSupabaseAdminClient();

    let productQuery = admin
      .from('product')
      .select(
        'id, title, sku, unit_cost, is_active, shopify_product_id, shopify_variant_id, created_at, updated_at, is_bundle',
      )
      .eq('merchant_account_id', merchantAccountId)
      .order('title', { ascending: true })
      .order('id', { ascending: true })
      .range(parsedInput.offset, parsedInput.offset + limit - 1);

    if (parsedInput.q?.trim()) {
      const q = parsedInput.q.trim();
      productQuery = productQuery.or(`title.ilike.%${q}%,sku.ilike.%${q}%`);
    }

    const { data: productData, error: productError } = await productQuery;
    if (productError) return { ok: false as const, errorCode: 'load_failed' as const };

    const hasMore = (productData?.length ?? 0) > PRODUCTS_PER_PAGE;
    const products = hasMore ? productData.slice(0, PRODUCTS_PER_PAGE) : (productData ?? []);
    const productIds = products.map((p) => p.id);

    const { data: stocks } =
      productIds.length > 0
        ? await admin
            .from('product_stock')
            .select('product_id, qty_on_hand, qty_reserved, unit_cost, low_stock_threshold')
            .eq('merchant_account_id', merchantAccountId)
            .in('product_id', productIds)
        : { data: [] };

    const stockMap = new Map((stocks ?? []).map((s) => [s.product_id, s]));

    const bundleIds = products.filter((p) => p.is_bundle).map((p) => p.id);
    const bundleAvailabilityMap = await resolveBundleAvailabilities(
      admin,
      merchantAccountId,
      bundleIds,
    );

    const items: ProductsPageItem[] = products.map((p) => {
      const s = stockMap.get(p.id);
      const qtyOnHand = s?.qty_on_hand ?? 0;
      const qtyReserved = s?.qty_reserved ?? 0;
      const qtyAvailable = Math.max(0, qtyOnHand - qtyReserved);
      const threshold = s?.low_stock_threshold ?? 10;
      return {
        id: p.id,
        title: p.title,
        sku: p.sku,
        unit_cost: canSeeCost ? (p.unit_cost ?? 0) : null,
        is_active: p.is_active,
        shopify_product_id: p.shopify_product_id,
        shopify_variant_id: p.shopify_variant_id,
        created_at: p.created_at,
        updated_at: p.updated_at,
        qtyOnHand,
        qtyReserved,
        qtyAvailable,
        lowStockThreshold: threshold,
        isLowStock: qtyOnHand <= threshold,
        stockUnitCost: canSeeCost ? (s?.unit_cost ?? 0) : null,
        stockValue: canSeeCost ? qtyOnHand * (s?.unit_cost ?? 0) : null,
        isBundle: p.is_bundle,
        bundleAvailability: p.is_bundle ? (bundleAvailabilityMap.get(p.id) ?? null) : null,
      };
    });

    return {
      ok: true as const,
      items,
      hasMore,
      nextOffset: parsedInput.offset + PRODUCTS_PER_PAGE,
    };
  });
