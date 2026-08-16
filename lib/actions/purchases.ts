'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { computeEta, formatEtaDate } from '@/lib/purchases/eta';
import { allocateFees } from '@/lib/purchases/fee-allocation';
import type { Database, Json } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getRequestStoreId } from '@/lib/workspace/store';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// receive_purchase_lot est SECURITY DEFINER avec garde de rôle NULL-safe (0043) :
// l'appelant DOIT être membre (current_member_role non NULL) sinon « forbidden ».
// On l'appelle donc via le client authentifié (owner) — jamais en service-role,
// qui n'a pas d'auth.uid() et serait rejeté.
function receivePurchaseLotRpc(client: { rpc: SupabaseClient<Database>['rpc'] }) {
  return client.rpc.bind(client) as unknown as (
    fn: 'receive_purchase_lot',
    args: {
      p_lot_id: string;
      p_merchant_account_id: string;
      p_actor_id: string;
      p_lines: Json;
    },
  ) => Promise<{ data: null; error: { message: string } | null }>;
}

// Lot C : modèle simplifié — un seul frais « Transport », un seul « délai estimé »,
// et un prix d'achat global par ligne (plus de prix unitaire saisi).
const lotBaseSchema = z.object({
  supplierName: z.string().trim().min(1).max(200),
  reference: z.string().trim().max(100).nullable().optional(),
  orderedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  estimatedLeadTimeDays: z.number().int().min(0).max(3650).default(0),
  transportTotal: z.number().int().min(0).default(0),
});

const lineSchema = z.object({
  productId: z.string().uuid(),
  qty: z.number().int().min(0),
  purchasePriceTotal: z.number().int().min(0),
});

// ── CREATE LOT ──────────────────────────────────────────────────────────────

export const createPurchaseLotAction = requireRole('owner')
  .metadata({ actionName: 'purchases.create_lot', section: 'purchases' })
  .inputSchema(
    lotBaseSchema.extend({
      lines: z.array(lineSchema).min(1),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const { merchantAccountId } = ctx.member;
    const admin = createSupabaseAdminClient();

    // Boutique ACTIVE explicite. `getPurchaseLotPageData` lit déjà les lots avec
    // `.eq('shop_id', shopId)` : sans cette résolution, le trigger
    // `assign_default_store_context` rattacherait le lot à la boutique PAR DÉFAUT
    // et un marchand multi-boutiques ne reverrait jamais le lot qu'il vient de
    // créer depuis une autre boutique.
    const shopId = await getRequestStoreId();
    if (!shopId) return { ok: false as const, message: 'Boutique active introuvable.' };

    const { data: lot, error: lotErr } = await admin
      .from('purchase_lot')
      .insert({
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        supplier_name: parsedInput.supplierName,
        reference: parsedInput.reference ?? null,
        ordered_at: parsedInput.orderedAt,
        estimated_lead_time_days: parsedInput.estimatedLeadTimeDays,
        transport_total: parsedInput.transportTotal,
      })
      .select('id')
      .single();

    if (lotErr || !lot)
      return { ok: false as const, message: lotErr?.message ?? 'Erreur création lot.' };

    const { error: lineErr } = await admin.from('purchase_lot_line').insert(
      parsedInput.lines.map((l) => ({
        merchant_account_id: merchantAccountId,
        // Une ligne appartient à SON lot : même boutique, par construction.
        shop_id: shopId,
        purchase_lot_id: lot.id,
        product_id: l.productId,
        qty: l.qty,
        purchase_price_total: l.purchasePriceTotal,
      })),
    );

    if (lineErr) return { ok: false as const, message: lineErr.message };

    revalidatePath('/produits');
    return { ok: true as const, lotId: lot.id };
  });

// ── UPDATE LOT DETAILS ───────────────────────────────────────────────────────

export const updatePurchaseLotAction = requireRole('owner')
  .metadata({ actionName: 'purchases.update_lot', section: 'purchases' })
  .inputSchema(lotBaseSchema.extend({ lotId: z.string().uuid() }))
  .action(async ({ ctx, parsedInput }) => {
    const { merchantAccountId } = ctx.member;
    const admin = createSupabaseAdminClient();

    const { error } = await admin
      .from('purchase_lot')
      .update({
        supplier_name: parsedInput.supplierName,
        reference: parsedInput.reference ?? null,
        ordered_at: parsedInput.orderedAt,
        estimated_lead_time_days: parsedInput.estimatedLeadTimeDays,
        transport_total: parsedInput.transportTotal,
      })
      .eq('id', parsedInput.lotId)
      .eq('merchant_account_id', merchantAccountId)
      .neq('status', 'received');

    if (error) return { ok: false as const, message: error.message };
    revalidatePath('/produits');
    return { ok: true as const };
  });

// ── ADD LINE ─────────────────────────────────────────────────────────────────

export const addPurchaseLotLineAction = requireRole('owner')
  .metadata({ actionName: 'purchases.add_line', section: 'purchases' })
  .inputSchema(lineSchema.extend({ lotId: z.string().uuid() }))
  .action(async ({ ctx, parsedInput }) => {
    const { merchantAccountId } = ctx.member;
    const admin = createSupabaseAdminClient();

    const { data: lot } = await admin
      .from('purchase_lot')
      .select('status, shop_id')
      .eq('id', parsedInput.lotId)
      .eq('merchant_account_id', merchantAccountId)
      .single();

    if (!lot) return { ok: false as const, message: 'Lot introuvable.' };
    if (lot.status === 'received') return { ok: false as const, message: 'Lot déjà reçu.' };

    const { error } = await admin.from('purchase_lot_line').insert({
      merchant_account_id: merchantAccountId,
      // Boutique héritée du LOT porteur, pas de la boutique active : une ligne ne
      // peut pas vivre dans une autre boutique que son lot.
      shop_id: lot.shop_id,
      purchase_lot_id: parsedInput.lotId,
      product_id: parsedInput.productId,
      qty: parsedInput.qty,
      purchase_price_total: parsedInput.purchasePriceTotal,
    });

    if (error) return { ok: false as const, message: error.message };
    revalidatePath('/produits');
    return { ok: true as const };
  });

// ── REMOVE LINE ──────────────────────────────────────────────────────────────

export const removePurchaseLotLineAction = requireRole('owner')
  .metadata({ actionName: 'purchases.remove_line', section: 'purchases' })
  .inputSchema(z.object({ lineId: z.string().uuid(), lotId: z.string().uuid() }))
  .action(async ({ ctx, parsedInput }) => {
    const { merchantAccountId } = ctx.member;
    const admin = createSupabaseAdminClient();

    const { data: lot } = await admin
      .from('purchase_lot')
      .select('status')
      .eq('id', parsedInput.lotId)
      .eq('merchant_account_id', merchantAccountId)
      .single();

    if (!lot) return { ok: false as const, message: 'Lot introuvable.' };
    if (lot.status === 'received') return { ok: false as const, message: 'Lot déjà reçu.' };

    const { error } = await admin
      .from('purchase_lot_line')
      .delete()
      .eq('id', parsedInput.lineId)
      .eq('purchase_lot_id', parsedInput.lotId)
      .eq('merchant_account_id', merchantAccountId);

    if (error) return { ok: false as const, message: error.message };
    revalidatePath('/produits');
    return { ok: true as const };
  });

// ── MARK IN-TRANSIT ──────────────────────────────────────────────────────────

export const markLotInTransitAction = requireRole('owner')
  .metadata({ actionName: 'purchases.mark_in_transit', section: 'purchases' })
  .inputSchema(z.object({ lotId: z.string().uuid() }))
  .action(async ({ ctx, parsedInput }) => {
    const { merchantAccountId } = ctx.member;
    const admin = createSupabaseAdminClient();

    const { error } = await admin
      .from('purchase_lot')
      .update({ status: 'in_transit' })
      .eq('id', parsedInput.lotId)
      .eq('merchant_account_id', merchantAccountId)
      .eq('status', 'ordered');

    if (error) return { ok: false as const, message: error.message };
    revalidatePath('/produits');
    return { ok: true as const };
  });

// ── RECEIVE LOT (ATOMIQUE) ────────────────────────────────────────────────────

export const receiveLotAction = requireRole('owner')
  .metadata({ actionName: 'purchases.receive_lot', section: 'purchases' })
  .inputSchema(z.object({ lotId: z.string().uuid() }))
  .action(async ({ ctx, parsedInput }) => {
    const { merchantAccountId } = ctx.member;
    const admin = createSupabaseAdminClient();

    // Charger le lot + ses lignes.
    const { data: lot, error: lotErr } = await admin
      .from('purchase_lot')
      .select('*')
      .eq('id', parsedInput.lotId)
      .eq('merchant_account_id', merchantAccountId)
      .single();

    if (lotErr || !lot) return { ok: false as const, message: 'Lot introuvable.' };
    if (lot.status === 'received') return { ok: false as const, message: 'Lot déjà reçu.' };

    const { data: lines, error: lineErr } = await admin
      .from('purchase_lot_line')
      .select('id, product_id, qty, purchase_price_total')
      .eq('purchase_lot_id', parsedInput.lotId)
      .eq('merchant_account_id', merchantAccountId);

    if (lineErr || !lines || lines.length === 0) {
      return { ok: false as const, message: 'Aucune ligne sur ce lot.' };
    }

    // Répartition du transport (plus grand reste, valeurs en FCFA).
    const allocated = allocateFees(
      lines.map((l) => ({ qty: l.qty, purchasePriceTotal: l.purchase_price_total ?? 0 })),
      lot.transport_total ?? 0,
    );

    // Construire le JSON pour le RPC (valeurs atterries figées par ligne).
    const linesJson = lines.map((l, i) => ({
      line_id: l.id,
      line_value: allocated[i].lineValue,
      allocated_fees: allocated[i].allocatedFees,
      landed_total_value: allocated[i].landedTotalValue,
      landed_unit_cost: allocated[i].landedUnitCost,
    }));

    // Appel RPC atomique — une transaction Postgres (0034 appliquée en prod).
    // Via le client authentifié (owner) : la garde NULL-safe 0043 rejette le service-role.
    const receive = receivePurchaseLotRpc(ctx.supabase);
    const { error: rpcErr } = await receive('receive_purchase_lot', {
      p_lot_id: parsedInput.lotId,
      p_merchant_account_id: merchantAccountId,
      p_actor_id: ctx.user.id,
      p_lines: linesJson as Json,
    });

    if (rpcErr) return { ok: false as const, message: rpcErr.message };

    revalidatePath('/produits');
    return { ok: true as const };
  });

// ── PAGE DATA ─────────────────────────────────────────────────────────────────

export type PurchaseLotLineData = {
  id: string;
  productId: string;
  productTitle: string;
  productSku: string | null;
  qty: number;
  purchasePriceTotal: number;
  lineValue: number | null;
  allocatedFees: number | null;
  landedTotalValue: number | null;
  landedUnitCost: number | null;
  preview: {
    lineValue: number;
    allocatedFees: number;
    landedTotalValue: number;
    landedUnitCost: number;
  } | null;
};

export type PurchaseLotData = {
  id: string;
  supplierName: string;
  reference: string | null;
  orderedAt: string;
  status: 'ordered' | 'in_transit' | 'received';
  estimatedLeadTimeDays: number;
  eta: string;
  transportTotal: number;
  receivedAt: string | null;
  lines: PurchaseLotLineData[];
};

export type PurchaseLotPageData =
  | { ok: true; lots: PurchaseLotData[] }
  | { ok: false; message: string };

export async function getPurchaseLotPageData(shopId: string): Promise<PurchaseLotPageData> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: 'Session introuvable.' };

  // Admin client : contourne les grants de colonnes RLS pour éviter
  // que le type inféré de maybeSingle() soit never sur des colonnes restreintes.
  const admin = createSupabaseAdminClient();
  const { data: member } = await admin
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  if (!member) return { ok: false, message: 'Compte marchand introuvable.' };
  if (member.role !== 'owner') return { ok: false, message: 'Accès réservé au propriétaire.' };

  const merchantAccountId = member.merchant_account_id;

  const { data: lots, error: lotErr } = await admin
    .from('purchase_lot')
    .select('*')
    .eq('merchant_account_id', merchantAccountId)
    .eq('shop_id', shopId)
    .order('ordered_at', { ascending: false });

  if (lotErr) return { ok: false, message: lotErr.message };

  if (!lots || lots.length === 0) return { ok: true, lots: [] };

  const lotIds = lots.map((l) => l.id);
  const { data: rawLines, error: lineErr } = await admin
    .from('purchase_lot_line')
    .select('*, product(id, title, sku)')
    .in('purchase_lot_id', lotIds)
    .eq('merchant_account_id', merchantAccountId)
    .eq('shop_id', shopId);

  if (lineErr) return { ok: false, message: lineErr.message };

  const linesByLot = new Map<string, typeof rawLines>();
  for (const line of rawLines ?? []) {
    const bucket = linesByLot.get(line.purchase_lot_id) ?? [];
    bucket.push(line);
    linesByLot.set(line.purchase_lot_id, bucket);
  }

  const result: PurchaseLotData[] = lots.map((lot) => {
    const lotLines = linesByLot.get(lot.id) ?? [];
    const transportTotal = lot.transport_total ?? 0;

    const previewAlloc =
      lot.status !== 'received' && lotLines.length > 0
        ? allocateFees(
            lotLines.map((l) => ({
              qty: l.qty,
              purchasePriceTotal: l.purchase_price_total ?? 0,
            })),
            transportTotal,
          )
        : null;

    const eta = formatEtaDate(
      computeEta({
        ordered_at: lot.ordered_at,
        estimated_lead_time_days: lot.estimated_lead_time_days ?? 0,
      }),
    );

    const lines: PurchaseLotLineData[] = lotLines.map((l, i) => {
      const prod = l.product as { id: string; title: string; sku: string | null } | null;
      return {
        id: l.id,
        productId: l.product_id,
        productTitle: prod?.title ?? l.product_id,
        productSku: prod?.sku ?? null,
        qty: l.qty,
        purchasePriceTotal: l.purchase_price_total ?? 0,
        lineValue: l.line_value,
        allocatedFees: l.allocated_fees,
        landedTotalValue: l.landed_total_value,
        landedUnitCost: l.landed_unit_cost,
        preview: previewAlloc ? previewAlloc[i] : null,
      };
    });

    return {
      id: lot.id,
      supplierName: lot.supplier_name,
      reference: lot.reference,
      orderedAt: lot.ordered_at,
      status: lot.status as 'ordered' | 'in_transit' | 'received',
      estimatedLeadTimeDays: lot.estimated_lead_time_days ?? 0,
      eta,
      transportTotal,
      receivedAt: lot.received_at,
      lines,
    };
  });

  return { ok: true, lots: result };
}
