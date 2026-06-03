'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import type { Database, Tables } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { type TeamRole, isTeamRole } from '@/lib/team/permissions';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

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
