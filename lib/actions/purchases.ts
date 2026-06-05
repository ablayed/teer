'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { computeEta, formatEtaDate } from '@/lib/purchases/eta';
import { allocateFees } from '@/lib/purchases/fee-allocation';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const lotBaseSchema = z.object({
  supplierName: z.string().trim().min(1).max(200),
  reference: z.string().trim().max(100).nullable().optional(),
  orderedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shippingMode: z.enum(['fast', 'normal']).default('normal'),
  supplierPrepDays: z.number().int().min(0).default(0),
  transportDays: z.number().int().min(0).default(0),
  localBufferDays: z.number().int().min(0).default(0),
  etaOverride: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  freightTotal: z.number().int().min(0).default(0),
  customsTotal: z.number().int().min(0).default(0),
  transitTotal: z.number().int().min(0).default(0),
  localTransportTotal: z.number().int().min(0).default(0),
});

const lineSchema = z.object({
  productId: z.string().uuid(),
  qty: z.number().int().min(0),
  unitPurchasePrice: z.number().int().min(0),
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

    const { data: lot, error: lotErr } = await admin
      .from('purchase_lot')
      .insert({
        merchant_account_id: merchantAccountId,
        supplier_name: parsedInput.supplierName,
        reference: parsedInput.reference ?? null,
        ordered_at: parsedInput.orderedAt,
        shipping_mode: parsedInput.shippingMode,
        supplier_prep_days: parsedInput.supplierPrepDays,
        transport_days: parsedInput.transportDays,
        local_buffer_days: parsedInput.localBufferDays,
        eta_override: parsedInput.etaOverride ?? null,
        freight_total: parsedInput.freightTotal,
        customs_total: parsedInput.customsTotal,
        transit_total: parsedInput.transitTotal,
        local_transport_total: parsedInput.localTransportTotal,
      })
      .select('id')
      .single();

    if (lotErr || !lot)
      return { ok: false as const, message: lotErr?.message ?? 'Erreur création lot.' };

    const { error: lineErr } = await admin.from('purchase_lot_line').insert(
      parsedInput.lines.map((l) => ({
        merchant_account_id: merchantAccountId,
        purchase_lot_id: lot.id,
        product_id: l.productId,
        qty: l.qty,
        unit_purchase_price: l.unitPurchasePrice,
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
        shipping_mode: parsedInput.shippingMode,
        supplier_prep_days: parsedInput.supplierPrepDays,
        transport_days: parsedInput.transportDays,
        local_buffer_days: parsedInput.localBufferDays,
        eta_override: parsedInput.etaOverride ?? null,
        freight_total: parsedInput.freightTotal,
        customs_total: parsedInput.customsTotal,
        transit_total: parsedInput.transitTotal,
        local_transport_total: parsedInput.localTransportTotal,
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
      .select('status')
      .eq('id', parsedInput.lotId)
      .eq('merchant_account_id', merchantAccountId)
      .single();

    if (!lot) return { ok: false as const, message: 'Lot introuvable.' };
    if (lot.status === 'received') return { ok: false as const, message: 'Lot déjà reçu.' };

    const { error } = await admin.from('purchase_lot_line').insert({
      merchant_account_id: merchantAccountId,
      purchase_lot_id: parsedInput.lotId,
      product_id: parsedInput.productId,
      qty: parsedInput.qty,
      unit_purchase_price: parsedInput.unitPurchasePrice,
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

    // Charger le lot + ses lignes avec les titres produit.
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
      .select('id, product_id, qty, unit_purchase_price')
      .eq('purchase_lot_id', parsedInput.lotId)
      .eq('merchant_account_id', merchantAccountId);

    if (lineErr || !lines || lines.length === 0) {
      return { ok: false as const, message: 'Aucune ligne sur ce lot.' };
    }

    // Calculer la répartition des frais (plus grand reste, valeurs en FCFA).
    const allocated = allocateFees(
      lines.map((l) => ({ qty: l.qty, unitPurchasePrice: l.unit_purchase_price })),
      {
        freightTotal: lot.freight_total,
        customsTotal: lot.customs_total,
        transitTotal: lot.transit_total,
        localTransportTotal: lot.local_transport_total,
      },
    );

    // Construire le JSON pour le RPC.
    const linesJson = lines.map((l, i) => ({
      line_id: l.id,
      line_value: allocated[i].lineValue,
      allocated_fees: allocated[i].allocatedFees,
      landed_total_value: allocated[i].landedTotalValue,
      landed_unit_cost: allocated[i].landedUnitCost,
    }));

    // Appel RPC atomique — une transaction Postgres (0034 appliquée en prod,
    // receive_purchase_lot typé nativement dans database.types.ts).
    const { error: rpcErr } = await admin.rpc('receive_purchase_lot', {
      p_lot_id: parsedInput.lotId,
      p_merchant_account_id: merchantAccountId,
      p_actor_id: ctx.user.id,
      p_lines: linesJson,
    });

    if (rpcErr) return { ok: false as const, message: rpcErr.message };

    revalidatePath('/produits');
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
  unitPurchasePrice: number;
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
  shippingMode: string;
  supplierPrepDays: number;
  transportDays: number;
  localBufferDays: number;
  etaOverride: string | null;
  eta: string;
  freightTotal: number;
  customsTotal: number;
  transitTotal: number;
  localTransportTotal: number;
  totalFees: number;
  receivedAt: string | null;
  lines: PurchaseLotLineData[];
};

export type PurchaseLotPageData =
  | { ok: true; lots: PurchaseLotData[] }
  | { ok: false; message: string };

export async function getPurchaseLotPageData(): Promise<PurchaseLotPageData> {
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
    .order('ordered_at', { ascending: false });

  if (lotErr) return { ok: false, message: lotErr.message };

  if (!lots || lots.length === 0) return { ok: true, lots: [] };

  const lotIds = lots.map((l) => l.id);
  const { data: rawLines, error: lineErr } = await admin
    .from('purchase_lot_line')
    .select('*, product(id, title, sku)')
    .in('purchase_lot_id', lotIds)
    .eq('merchant_account_id', merchantAccountId);

  if (lineErr) return { ok: false, message: lineErr.message };

  const linesByLot = new Map<string, typeof rawLines>();
  for (const line of rawLines ?? []) {
    const bucket = linesByLot.get(line.purchase_lot_id) ?? [];
    bucket.push(line);
    linesByLot.set(line.purchase_lot_id, bucket);
  }

  const result: PurchaseLotData[] = lots.map((lot) => {
    const lotLines = linesByLot.get(lot.id) ?? [];
    const fees = {
      freightTotal: lot.freight_total,
      customsTotal: lot.customs_total,
      transitTotal: lot.transit_total,
      localTransportTotal: lot.local_transport_total,
    };
    const totalFees =
      fees.freightTotal + fees.customsTotal + fees.transitTotal + fees.localTransportTotal;

    const previewAlloc =
      lot.status !== 'received' && lotLines.length > 0
        ? allocateFees(
            lotLines.map((l) => ({ qty: l.qty, unitPurchasePrice: l.unit_purchase_price })),
            fees,
          )
        : null;

    const eta = formatEtaDate(
      computeEta({
        ordered_at: lot.ordered_at,
        supplier_prep_days: lot.supplier_prep_days,
        transport_days: lot.transport_days,
        local_buffer_days: lot.local_buffer_days,
        eta_override: lot.eta_override,
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
        unitPurchasePrice: l.unit_purchase_price,
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
      shippingMode: lot.shipping_mode,
      supplierPrepDays: lot.supplier_prep_days,
      transportDays: lot.transport_days,
      localBufferDays: lot.local_buffer_days,
      etaOverride: lot.eta_override,
      eta,
      freightTotal: lot.freight_total,
      customsTotal: lot.customs_total,
      transitTotal: lot.transit_total,
      localTransportTotal: lot.local_transport_total,
      totalFees,
      receivedAt: lot.received_at,
      lines,
    };
  });

  return { ok: true, lots: result };
}
