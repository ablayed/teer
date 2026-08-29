'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { resolveProductInShop } from '@/lib/actions/stock';
import { env } from '@/lib/env';
import {
  type AllocationMethod,
  isAllocationMethodAvailable,
} from '@/lib/finance/lot-profitability';
import {
  type PurchaseLotProfitabilityRpcResult,
  type PurchaseLotProfitabilitySummary,
  assemblePurchaseLotProfitability,
} from '@/lib/finance/lot-profitability-assembly';
import { computeEta, formatEtaDate } from '@/lib/purchases/eta';
import { allocateFees } from '@/lib/purchases/fee-allocation';
import type { Database, Json } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getRequestStoreId } from '@/lib/workspace/store';
import * as Sentry from '@sentry/nextjs';
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

// get_purchase_lot_profitability est SECURITY INVOKER, sans garde de rôle : les
// policies RLS existantes (owner-only sur purchase_lot/purchase_lot_line)
// s'appliquent sous l'identité de l'appelant. Appelée via le client
// authentifié — RLS est le SEUL gate de cette lecture, jamais l'admin.
// Cast temporaire : database.types.ts ne connaît pas encore cette fonction
// (migration 0146 non poussée) — à retirer une fois le type régénéré.
function getPurchaseLotProfitabilityRpc(client: { rpc: SupabaseClient<Database>['rpc'] }) {
  return client.rpc.bind(client) as unknown as (
    fn: 'get_purchase_lot_profitability',
    args: { p_purchase_lot_id: string },
  ) => Promise<{
    data: PurchaseLotProfitabilityRpcResult | null;
    error: { message: string } | null;
  }>;
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

    // Fuite 3 (post-mortem 0138) : chaque productId doit être confronté à la boutique
    // AVANT la première mutation — createPurchaseLotAction fait 2 appels PostgREST non
    // transactionnels (lot puis lignes) ; un refus après l'insert du lot laisserait un
    // lot orphelin en base. Ici la boutique active EST la boutique du lot qu'on s'apprête
    // à créer (même valeur) : resolveProductInShop(shopId=active) est donc le bon parent.
    for (const line of parsedInput.lines) {
      const resolution = await resolveProductInShop(
        admin,
        merchantAccountId,
        shopId,
        line.productId,
      );
      if (!resolution.ok) return { ok: false as const, message: resolution.message };
    }

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

    // Fuite 3 (post-mortem 0138) : confronte productId à la boutique DU LOT, jamais la
    // boutique active — l'utilisateur a pu en changer depuis la création du lot. Avant
    // la première (et unique) mutation de cette action.
    const resolution = await resolveProductInShop(
      admin,
      merchantAccountId,
      lot.shop_id,
      parsedInput.productId,
    );
    if (!resolution.ok) return { ok: false as const, message: resolution.message };

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
  weightGrams: number | null;
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
  allocationMethod: AllocationMethod;
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
        weightGrams: l.weight_grams,
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
      allocationMethod: lot.allocation_method as AllocationMethod,
      lines,
    };
  });

  return { ok: true, lots: result };
}

// ── PROFITABILITY (Lot F2) ───────────────────────────────────────────────────

// Intentionnellement appelable depuis un COMPOSANT CLIENT (pas seulement le
// RSC) — `purchase-lot-detail-panel.tsx`'s `refreshProfitability()` l'appelle
// directement après chaque écriture réussie (méthode/poids/dépense pub) pour
// relire la rentabilité fraîche côté serveur (Paradigm B, cf. CLAUDE.md :
// jamais de `router.refresh()` pour ce genre de lecture post-mutation). C'est
// sûr précisément parce que cette fonction utilise `createSupabaseServerClient()`
// (respecte RLS, sous l'identité de l'appelant) — contrairement aux autres
// fonctions de ce fichier qui passent par `createSupabaseAdminClient()` pour
// leurs écritures ; ne jamais faire suivre ce même chemin admin à une fonction
// appelée depuis le client.
export async function getPurchaseLotProfitability(
  lotId: string,
): Promise<PurchaseLotProfitabilitySummary> {
  const supabase = await createSupabaseServerClient();
  const call = getPurchaseLotProfitabilityRpc(supabase);
  const { data, error } = await call('get_purchase_lot_profitability', {
    p_purchase_lot_id: lotId,
  });

  if (error) {
    // Une vraie erreur RPC (permission, timeout, PGRST202 tant que 0146 n'est
    // pas déployée) n'est PAS « lot introuvable » — CLAUDE.md (toMetricLoadState)
    // interdit de faire retomber une panne d'action financière sur 0/liste vide.
    Sentry.captureException(new Error('get_purchase_lot_profitability_rpc_failed'), {
      tags: { module: 'purchases.get_purchase_lot_profitability' },
      extra: { lotId, message: error.message },
    });
    return { ok: false, reason: 'error' };
  }
  return assemblePurchaseLotProfitability(data);
}

const allocationMethodSchema = z.object({
  lotId: z.string().uuid(),
  method: z.enum(['value', 'quantity', 'weight']),
});

export const setPurchaseLotAllocationMethodAction = requireRole('owner')
  .metadata({ actionName: 'purchases.set_allocation_method', section: 'purchases' })
  .inputSchema(allocationMethodSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { merchantAccountId } = ctx.member;
    const admin = createSupabaseAdminClient();

    // Boutique ACTIVE explicite — un owner multi-boutiques du même tenant ne
    // doit jamais pouvoir écrire sur un lot d'une autre boutique que celle où
    // il agit (finding revue : le service-role bypass RLS, le seul filtre
    // merchant_account_id ne suffit pas). Échec fermé si non résolue.
    const shopId = await getRequestStoreId();
    if (!shopId) return { ok: false as const, message: 'Boutique active introuvable.' };

    // lotId confronté à son parent autoritaire (compte marchand + boutique
    // active) AVANT toute écriture — motif récurrent du projet (0134/0135,
    // cross-tenant webhooks). Un lot d'une autre boutique du même tenant doit
    // échouer en « Lot introuvable », jamais en un update qui touche 0 ligne
    // silencieusement.
    const { data: lot } = await admin
      .from('purchase_lot')
      .select('id')
      .eq('id', parsedInput.lotId)
      .eq('merchant_account_id', merchantAccountId)
      .eq('shop_id', shopId)
      .maybeSingle();

    if (!lot) return { ok: false as const, message: 'Lot introuvable.' };

    const { data: lines, error: lineErr } = await admin
      .from('purchase_lot_line')
      .select('weight_grams')
      .eq('purchase_lot_id', parsedInput.lotId)
      .eq('merchant_account_id', merchantAccountId)
      .eq('shop_id', shopId);

    if (lineErr) return { ok: false as const, message: lineErr.message };

    if (parsedInput.method === 'weight') {
      const availability = isAllocationMethodAvailable(
        (lines ?? []).map((l) => ({ weightGrams: l.weight_grams })),
        'weight',
      );
      if (!availability.available) {
        return {
          ok: false as const,
          message:
            'Poids manquant sur au moins une ligne : la répartition au poids est indisponible.',
        };
      }
    }

    const { error } = await admin
      .from('purchase_lot')
      .update({ allocation_method: parsedInput.method })
      .eq('id', parsedInput.lotId)
      .eq('merchant_account_id', merchantAccountId)
      .eq('shop_id', shopId);

    if (error) return { ok: false as const, message: error.message };
    revalidatePath('/produits');
    return { ok: true as const };
  });

const setWeightSchema = z.object({
  lotId: z.string().uuid(),
  lineId: z.string().uuid(),
  weightGrams: z.number().int().min(0).nullable(),
});

export const setPurchaseLotLineWeightAction = requireRole('owner')
  .metadata({ actionName: 'purchases.set_line_weight', section: 'purchases' })
  .inputSchema(setWeightSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { merchantAccountId } = ctx.member;
    const admin = createSupabaseAdminClient();

    // Boutique ACTIVE explicite — même garde que setPurchaseLotAllocationMethodAction
    // (finding revue : le service-role bypass RLS, seul merchant_account_id ne
    // suffit pas à empêcher une écriture cross-boutique du même tenant).
    const shopId = await getRequestStoreId();
    if (!shopId) return { ok: false as const, message: 'Boutique active introuvable.' };

    // lineId ET lotId confrontés à leur parent autoritaire (compte marchand +
    // boutique active) dans la même clause .eq() que l'écriture — jamais un
    // identifiant reçu du client transmis sans être vérifié contre son parent.
    const { error } = await admin
      .from('purchase_lot_line')
      .update({ weight_grams: parsedInput.weightGrams })
      .eq('id', parsedInput.lineId)
      .eq('purchase_lot_id', parsedInput.lotId)
      .eq('merchant_account_id', merchantAccountId)
      .eq('shop_id', shopId);

    if (error) return { ok: false as const, message: error.message };
    revalidatePath('/produits');
    return { ok: true as const };
  });

const createAdSpendSchema = z.object({
  productId: z.string().uuid(),
  purchaseLotId: z.string().uuid(), // jamais optionnel dans CETTE action — règle non négociable du prompt F2
  amountMinor: z.number().int().min(0),
  spentAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  clientRequestId: z.string().uuid(), // idempotence — écrit dans external_ref
});

const AD_SPEND_UNIQUE_EXTERNAL_REF_VIOLATION = '23505';

export const createProductAdSpendAction = requireRole('owner')
  .metadata({ actionName: 'purchases.create_ad_spend', section: 'purchases' })
  .inputSchema(createAdSpendSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { merchantAccountId } = ctx.member;
    const admin = createSupabaseAdminClient();

    // Boutique ACTIVE explicite — même garde que les deux actions ci-dessus :
    // le service-role bypass RLS, seul merchant_account_id ne suffit pas à
    // empêcher une écriture cross-boutique du même tenant.
    const shopId = await getRequestStoreId();
    if (!shopId) return { ok: false as const, message: 'Boutique active introuvable.' };

    // Le produit ET le lot doivent être confrontés à leur parent autoritaire
    // (compte + boutique active) AVANT toute écriture — motif récurrent du projet.
    const { data: product } = await admin
      .from('product')
      .select('id, shop_id')
      .eq('id', parsedInput.productId)
      .eq('merchant_account_id', merchantAccountId)
      .eq('shop_id', shopId)
      .maybeSingle();
    if (!product) return { ok: false as const, message: 'Produit introuvable.' };

    const { data: lot } = await admin
      .from('purchase_lot')
      .select('id')
      .eq('id', parsedInput.purchaseLotId)
      .eq('merchant_account_id', merchantAccountId)
      .eq('shop_id', shopId)
      .maybeSingle();
    if (!lot) return { ok: false as const, message: 'Arrivage introuvable.' };

    // Le produit ET le lot appartiennent chacun (vérifié ci-dessus) à la boutique
    // active — mais rien ne garantit encore qu'ils sont RÉELLEMENT liés : un
    // productId et un purchaseLotId valides mais sans rapport entre eux
    // passeraient les deux gardes précédentes. Sans cette troisième vérification,
    // product_ad_spend accepterait une dépense « orpheline » : sans ligne
    // d'arrivage réelle pour la porter, elle ne serait jamais distribuée par
    // computeAdSpendByLine (assemblage), donc jamais déduite de
    // totals.marginMinor ni comptée dans totals.adSpendMinor (les deux
    // dérivent désormais de la même distribution par construction) — mais
    // resterait quand même en base, invisible et non comptée nulle part tant
    // qu'aucune ligne ne la relie à ce lot. On confronte donc explicitement
    // le couple (productId, purchaseLotId) à son parent autoritaire : une
    // ligne d'arrivage.
    // .limit(1).maybeSingle() (jamais .maybeSingle() seul) : deux lignes du
    // même produit dans le même lot sont un cas légitime du domaine (cf.
    // toLotProductLine / lib/finance/lot-profitability-assembly.ts) — on ne
    // veut ici que l'existence d'AU MOINS une ligne, jamais l'unicité.
    const { data: line } = await admin
      .from('purchase_lot_line')
      .select('id')
      .eq('product_id', parsedInput.productId)
      .eq('purchase_lot_id', parsedInput.purchaseLotId)
      .eq('merchant_account_id', merchantAccountId)
      .eq('shop_id', shopId)
      .limit(1)
      .maybeSingle();
    if (!line) {
      return { ok: false as const, message: "Ce produit n'appartient pas à cet arrivage." };
    }

    const { error } = await admin.from('product_ad_spend').insert({
      merchant_account_id: merchantAccountId,
      shop_id: product.shop_id,
      product_id: parsedInput.productId,
      purchase_lot_id: parsedInput.purchaseLotId,
      amount_minor: parsedInput.amountMinor,
      spent_at: parsedInput.spentAt,
      source: 'manuel',
      external_ref: parsedInput.clientRequestId,
      created_by: ctx.user.id,
    });

    if (error) {
      // Renvoi de la même mutation (offline queue) : le doublon est REFUSÉ par
      // l'index unique (merchant_account_id, shop_id, external_ref) — traité
      // comme un succès idempotent, jamais comme une erreur.
      if (error.code === AD_SPEND_UNIQUE_EXTERNAL_REF_VIOLATION) {
        return { ok: true as const, alreadyRecorded: true as const };
      }
      return { ok: false as const, message: error.message };
    }

    revalidatePath('/produits');
    return { ok: true as const, alreadyRecorded: false as const };
  });

// ── AD SPEND — résolution des arrivages candidats depuis la fiche produit (Lot F2) ──

export type ProductAdSpendCandidateLot = { id: string; label: string };

const candidateLotsSchema = z.object({ productId: z.string().uuid() });

// Ouverte depuis la fiche produit (contexte lot inconnu, contrairement à la Fiche
// arrivage qui connaît déjà son lot) : résout les arrivages RECUS dont ce produit est
// réellement une ligne — jamais un choix par défaut silencieux si plusieurs candidats
// existent (règle F2 non négociable, cf. task-6-brief.md). Deux requêtes simples
// (lignes puis lots) plutôt qu'un embed PostgREST `purchase_lot!inner(...)` avec
// filtre pointé sur la table imbriquée : aucun appel de ce fichier n'utilise cette
// syntaxe ailleurs et elle n'a jamais été vérifiée contre ce schéma (migration 0146
// non poussée, pas de stack pour la tester en direct) — on reste sur le pattern
// éprouvé de `getPurchaseLotPageData` ci-dessus (.in('purchase_lot_id', lotIds)).
export const getProductAdSpendCandidateLotsAction = requireRole('owner')
  .metadata({ actionName: 'purchases.get_ad_spend_candidate_lots', section: 'purchases' })
  .inputSchema(candidateLotsSchema)
  .action(async ({ ctx, parsedInput }) => {
    const { merchantAccountId } = ctx.member;
    const admin = createSupabaseAdminClient();

    const shopId = await getRequestStoreId();
    if (!shopId) return { ok: false as const, message: 'Boutique active introuvable.' };

    // Le produit confronté à son parent autoritaire (compte + boutique active)
    // AVANT toute lecture dérivée — motif récurrent du projet.
    const { data: product } = await admin
      .from('product')
      .select('id')
      .eq('id', parsedInput.productId)
      .eq('merchant_account_id', merchantAccountId)
      .eq('shop_id', shopId)
      .maybeSingle();
    if (!product) return { ok: false as const, message: 'Produit introuvable.' };

    const { data: lineRows, error: lineErr } = await admin
      .from('purchase_lot_line')
      .select('purchase_lot_id')
      .eq('product_id', parsedInput.productId)
      .eq('merchant_account_id', merchantAccountId)
      .eq('shop_id', shopId);

    if (lineErr) return { ok: false as const, message: lineErr.message };

    // Un même lot peut porter deux lignes du même produit (cas légitime du domaine,
    // cf. commentaire dans createProductAdSpendAction ci-dessus) — dédupliqué ici :
    // l'arrivage n'apparaît qu'une fois dans le select, jamais en double.
    const lotIds = Array.from(new Set((lineRows ?? []).map((r) => r.purchase_lot_id)));
    if (lotIds.length === 0)
      return { ok: true as const, candidateLots: [] as ProductAdSpendCandidateLot[] };

    const { data: lots, error: lotErr } = await admin
      .from('purchase_lot')
      .select('id, supplier_name, received_at')
      .in('id', lotIds)
      .eq('merchant_account_id', merchantAccountId)
      .eq('shop_id', shopId)
      .eq('status', 'received')
      .order('received_at', { ascending: false });

    if (lotErr) return { ok: false as const, message: lotErr.message };

    const candidateLots: ProductAdSpendCandidateLot[] = (lots ?? []).map((l) => ({
      id: l.id,
      label: `${l.supplier_name} — ${l.received_at ?? ''}`,
    }));

    return { ok: true as const, candidateLots };
  });
