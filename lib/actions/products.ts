'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { resolveActiveStoreProduct } from '@/lib/actions/stock';
import { env } from '@/lib/env';
import { resolveBundleAvailabilities } from '@/lib/products/resolve-bundle-availability';
import {
  type StockCatalogSummary,
  computeStockCatalogSummary,
  fetchStockCatalogRows,
  isRowLowStock,
} from '@/lib/stock/stock-catalog-facts';
import type { Database, Tables } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { type TeamRole, isTeamRole } from '@/lib/team/permissions';
import { getRequestStoreId } from '@/lib/workspace/store';
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

const bundleCompositionInputSchema = z.object({
  bundleProductId: z.string().uuid(),
});

const saveBundleConfigurationSchema = z.object({
  productId: z.string().uuid(),
  isBundle: z.boolean(),
  components: z
    .array(
      z.object({
        componentProductId: z.string().uuid(),
        quantity: z.number().int().min(1).max(999),
      }),
    )
    .max(50),
});

type BundleConfigErrorCode =
  | 'bundle_not_found'
  | 'component_is_bundle'
  | 'component_not_found'
  | 'duplicate_component'
  | 'product_used_as_component'
  | 'self_reference'
  | 'store_required'
  | 'update_failed';

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
  shopId: string;
  lowStockOnly?: boolean;
  activeOnly?: boolean;
}): Promise<ProductsPageResult> {
  const currentMember = await getCurrentMember();
  if (!currentMember.ok) return currentMember;

  const { merchantAccountId, role } = currentMember.member;
  const canSeeCost = role === 'owner' || role === 'manager';
  const offset = params.offset ?? 0;
  const limit = PRODUCTS_PER_PAGE + 1;

  const admin = createSupabaseAdminClient();

  let lowStockIds: string[] | null = null;
  if (params.lowStockOnly) {
    const facts = await fetchStockCatalogRows(admin, merchantAccountId, params.shopId);
    if (!facts.ok) return { ok: false, errorCode: 'load_failed' };
    lowStockIds = computeStockCatalogSummary(facts.rows).lowStockProductIds;
    if (lowStockIds.length === 0) {
      return { ok: true, items: [], hasMore: false, nextOffset: 0, canSeeCost, currentRole: role };
    }
  }

  let productQuery = admin
    .from('product')
    .select(
      'id, title, sku, unit_cost, is_active, shopify_product_id, shopify_variant_id, created_at, updated_at, is_bundle',
    )
    .eq('merchant_account_id', merchantAccountId)
    .eq('shop_id', params.shopId)
    .order('title', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);

  if (params.activeOnly) {
    productQuery = productQuery.eq('is_active', true);
  }

  if (lowStockIds) {
    productQuery = productQuery.in('id', lowStockIds);
  }

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
          .eq('shop_id', params.shopId)
          .in('product_id', productIds)
      : { data: [] };

  const stockMap = new Map((stocks ?? []).map((s) => [s.product_id, s]));

  const bundleIds = products.filter((p) => p.is_bundle).map((p) => p.id);
  const bundleAvailabilityMap = await resolveBundleAvailabilities(
    admin,
    merchantAccountId,
    params.shopId,
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
      isLowStock: isRowLowStock(qtyOnHand, threshold),
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

export async function getStockCatalogSummaryData(
  shopId: string,
): Promise<{ ok: true; summary: StockCatalogSummary } | { ok: false; errorCode: string }> {
  const currentMember = await getCurrentMember();
  if (!currentMember.ok) return currentMember;
  const { merchantAccountId, role } = currentMember.member;
  const canSeeCost = role === 'owner' || role === 'manager';

  const admin = createSupabaseAdminClient();
  const result = await fetchStockCatalogRows(admin, merchantAccountId, shopId);
  if (!result.ok) return { ok: false, errorCode: 'load_failed' };

  const summary = computeStockCatalogSummary(result.rows);

  return {
    ok: true,
    summary: canSeeCost
      ? summary
      : {
          // Masqué : dérivé de unit_cost, une donnée de coût (RLS #9).
          totalValueMinor: null,
          costUnknownCount: 0,
          // Conservé : quantité, pas coût — l'agent voit et peut ouvrir la
          // même population "stock bas" que owner/manager.
          lowStockCount: summary.lowStockCount,
          lowStockProductIds: summary.lowStockProductIds,
        },
  };
}

export async function getProductCatalogPageData(shopId: string): Promise<ProductCatalogPageData> {
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
      .eq('shop_id', shopId)
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
    .eq('shop_id', shopId)
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
    const shopId = await getRequestStoreId();
    if (!shopId) return { ok: false as const, errorCode: 'store_required' as const };
    const unitCost = ctx.member.role === 'agent' ? 0 : parsedInput.unitCost;
    const { data, error } = await admin
      .from('product')
      .insert({
        merchant_account_id: ctx.member.merchantAccountId,
        shop_id: shopId,
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
    const shopId = await getRequestStoreId();
    if (!shopId) return { ok: false as const, errorCode: 'store_required' as const };
    const { error } = await admin
      .from('product')
      .update({
        unit_cost: parsedInput.unitCost,
        updated_at: new Date().toISOString(),
      })
      .eq('id', parsedInput.productId)
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .eq('shop_id', shopId);

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
      shopId: z.string().uuid(),
      lowStockOnly: z.boolean().optional(),
      activeOnly: z.boolean().optional(),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const { merchantAccountId, role } = ctx.member;
    const canSeeCost = role === 'owner' || role === 'manager';
    const limit = PRODUCTS_PER_PAGE + 1;

    const admin = createSupabaseAdminClient();
    const requestShopId = await getRequestStoreId();
    if (!requestShopId || requestShopId !== parsedInput.shopId) {
      return { ok: false as const, errorCode: 'store_required' as const };
    }
    const shopId = parsedInput.shopId;

    let lowStockIds: string[] | null = null;
    if (parsedInput.lowStockOnly) {
      const facts = await fetchStockCatalogRows(admin, merchantAccountId, shopId);
      if (!facts.ok) return { ok: false as const, errorCode: 'load_failed' as const };
      lowStockIds = computeStockCatalogSummary(facts.rows).lowStockProductIds;
      if (lowStockIds.length === 0) {
        return {
          ok: true as const,
          items: [],
          hasMore: false,
          nextOffset: parsedInput.offset + PRODUCTS_PER_PAGE,
        };
      }
    }

    let productQuery = admin
      .from('product')
      .select(
        'id, title, sku, unit_cost, is_active, shopify_product_id, shopify_variant_id, created_at, updated_at, is_bundle',
      )
      .eq('merchant_account_id', merchantAccountId)
      .eq('shop_id', shopId)
      .order('title', { ascending: true })
      .order('id', { ascending: true })
      .range(parsedInput.offset, parsedInput.offset + limit - 1);

    if (parsedInput.activeOnly) {
      productQuery = productQuery.eq('is_active', true);
    }

    if (lowStockIds) {
      productQuery = productQuery.in('id', lowStockIds);
    }

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
            .eq('shop_id', shopId)
            .in('product_id', productIds)
        : { data: [] };

    const stockMap = new Map((stocks ?? []).map((s) => [s.product_id, s]));

    const bundleIds = products.filter((p) => p.is_bundle).map((p) => p.id);
    const bundleAvailabilityMap = await resolveBundleAvailabilities(
      admin,
      merchantAccountId,
      shopId,
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
        isLowStock: isRowLowStock(qtyOnHand, threshold),
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

// PR 3 (bundles/packs — UI de configuration) : lit la composition existante d'un bundle,
// via ctx.supabase (client RLS) — la table accorde déjà SELECT à owner/manager/agent
// (migration 0107), mais on restreint l'action à owner/manager pour rester cohérent avec
// le reste de la gestion catalogue (gate déjà appliqué côté RLS insert/update/delete).
export const getBundleCompositionAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'products.get_bundle_composition', section: 'products' })
  .inputSchema(bundleCompositionInputSchema)
  .action(async ({ ctx, parsedInput }) => {
    const supabase = ctx.supabase as unknown as SupabaseServerClient;
    const shopId = await getRequestStoreId();
    if (!shopId) return { ok: false as const, errorCode: 'store_required' as const };
    const { data, error } = await supabase
      .from('product_bundle_component')
      .select('component_product_id, quantity')
      .eq('bundle_product_id', parsedInput.bundleProductId)
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .eq('shop_id', shopId);

    if (error) return { ok: false as const, errorCode: 'load_failed' as const };

    return {
      ok: true as const,
      components: (data ?? []).map((row) => ({
        componentProductId: row.component_product_id,
        quantity: row.quantity,
      })),
    };
  });

// PR 3 : sauvegarde la case "Pack/bundle" + la composition (remplacement total, même
// philosophie que replaceOrderCartAction/replace_order_cart — pas de diff ligne-à-ligne).
// Décision produit validée (Phase B, PR 3) : décocher "Pack/bundle" n'est JAMAIS bloqué,
// quel que soit l'historique de ventes ou les commandes en cours référençant ce bundle —
// cf. note CLAUDE.md dédiée. Les lignes de product_bundle_component existantes ne sont
// PAS supprimées quand isBundle passe à false (aucune garde ni cascade requise par cette
// décision) : elles restent en base, invisibles tant que is_bundle=false (PR 2 ne calcule
// la disponibilité dérivée que pour les produits is_bundle=true), et réapparaissent
// pré-remplies si le marchand recoche "Pack/bundle" plus tard sur ce même produit.
//
// Non-atomicité assumée (même classe que ProductsCatalog.onCreateProduct, qui enchaîne
// déjà createProductAction puis setLowStockThresholdAction en 2 appels non transactionnels) :
// la mise à jour de product.is_bundle et le remplacement de la composition sont 2 appels
// PostgREST séparés, pas une transaction unique. Si le premier réussit et le second échoue,
// le produit reste marqué is_bundle=true avec une composition vide/partielle — état
// récupérable en rouvrant le panneau et en réessayant, pas une corruption silencieuse.
export const saveBundleConfigurationAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'products.save_bundle_configuration', section: 'products' })
  .inputSchema(saveBundleConfigurationSchema)
  .action(async ({ ctx, parsedInput }) => {
    const supabase = ctx.supabase as unknown as SupabaseServerClient;
    const shopIdBeforeAnyMutation = await getRequestStoreId();
    if (!shopIdBeforeAnyMutation)
      return { ok: false as const, errorCode: 'store_required' as const };
    const { productId, isBundle, components } = parsedInput;

    // Auto-référence (bundle_product_id === component_product_id) volontairement NON
    // vérifiée ici en TS : la contrainte SQL product_bundle_component_no_self_reference
    // (migration 0107) est la seule source de vérité, catchée plus bas via insertError.
    // Un pré-check TS la court-circuiterait et masquerait un contournement direct de
    // l'action (payload construit hors UI) derrière une validation applicative au lieu
    // de la contrainte DB réellement testée.
    const uniqueComponentIds = new Set(components.map((c) => c.componentProductId));
    if (uniqueComponentIds.size !== components.length) {
      return {
        ok: false as const,
        errorCode: 'duplicate_component' satisfies BundleConfigErrorCode,
      };
    }

    // Fuite 2 (post-mortem 0137) : component_product_id/bundle_product_id n'étaient
    // jamais confrontés à la boutique active avant d'être écrits — un identifiant
    // forgé (autre boutique du même tenant, ou autre tenant) passait tel quel jusqu'au
    // trigger SQL, qui les rattrapait mais APRÈS que le `delete` ait déjà vidé une
    // composition existante valide. Toute résolution se fait donc ici, avant la
    // première mutation (`product.update`), sur id + merchant_account_id + shop_id —
    // même motif que resolveActiveStoreProduct (lib/actions/stock.ts), réutilisé tel
    // quel plutôt que dupliqué.
    const bundleResolution = await resolveActiveStoreProduct(
      supabase,
      ctx.member.merchantAccountId,
      productId,
    );
    if (!bundleResolution.ok) {
      return { ok: false as const, errorCode: 'bundle_not_found' satisfies BundleConfigErrorCode };
    }
    const shopId = bundleResolution.shopId;

    if (isBundle) {
      for (const component of components) {
        const componentResolution = await resolveActiveStoreProduct(
          supabase,
          ctx.member.merchantAccountId,
          component.componentProductId,
        );
        if (!componentResolution.ok) {
          return {
            ok: false as const,
            errorCode: 'component_not_found' satisfies BundleConfigErrorCode,
          };
        }
      }
    }

    const { error: flagError } = await supabase
      .from('product')
      .update({ is_bundle: isBundle, updated_at: new Date().toISOString() })
      .eq('id', productId)
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .eq('shop_id', shopId);

    if (flagError) {
      const errorCode: BundleConfigErrorCode = flagError.message.includes(
        'is already used as a bundle component',
      )
        ? 'product_used_as_component'
        : 'update_failed';
      return { ok: false as const, errorCode };
    }

    if (isBundle) {
      const { error: deleteError } = await supabase
        .from('product_bundle_component')
        .delete()
        .eq('bundle_product_id', productId)
        .eq('merchant_account_id', ctx.member.merchantAccountId)
        .eq('shop_id', shopId);

      if (deleteError) {
        return { ok: false as const, errorCode: 'update_failed' as const };
      }

      if (components.length > 0) {
        const { error: insertError } = await supabase.from('product_bundle_component').insert(
          components.map((c) => ({
            merchant_account_id: ctx.member.merchantAccountId,
            shop_id: shopId,
            bundle_product_id: productId,
            component_product_id: c.componentProductId,
            quantity: c.quantity,
          })),
        );

        if (insertError) {
          // Une auto-référence réelle (component_product_id === bundle_product_id) trippe
          // TOUJOURS "is itself a bundle" en premier, jamais le check constraint
          // no_self_reference : le trigger assert_bundle_component_integrity (BEFORE
          // INSERT) exige que le produit référencé par bundle_product_id soit
          // is_bundle=true — si c'est le même produit, son propre is_bundle=true fait
          // aussi échouer le 2e check du même trigger ("le composant ne doit pas être un
          // bundle") avant que Postgres n'évalue le check constraint. La branche
          // no_self_reference ci-dessous est donc une défense en profondeur actuellement
          // inatteignable par ce chemin, pas du code mort à supprimer sans vérifier
          // d'abord si l'ordre d'évaluation trigger/constraint a changé.
          const errorCode: BundleConfigErrorCode = insertError.message.includes(
            'is itself a bundle',
          )
            ? 'component_is_bundle'
            : insertError.message.includes('no_self_reference')
              ? 'self_reference'
              : 'update_failed';
          return { ok: false as const, errorCode };
        }
      }
    }

    revalidatePath('/produits');

    return { ok: true as const };
  });
