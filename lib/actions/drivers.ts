'use server';

import { requireRole } from '@/lib/actions/safe-action';
import type { DriverCashConsolidation } from '@/lib/drivers/cash-consolidation';
import { computeDriverStockSetPlan } from '@/lib/drivers/driver-stock-set';
import { type DriverPerformance, deriveDriverPerformance } from '@/lib/drivers/performance';
import {
  type DriverStockMovement,
  driverAvailableStockRows,
  driverStockRows,
} from '@/lib/drivers/stock-on-hand';
import { driverIdFilter, getStoreDriverIds } from '@/lib/drivers/store-scope';
import { env } from '@/lib/env';
import type { Database } from '@/lib/supabase/database.types';
import { fetchAllPostgrestRows } from '@/lib/supabase/pagination';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getRequestStoreId } from '@/lib/workspace/store';
import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

type PostStockMovementArgs = Database['public']['Functions']['post_stock_movement']['Args'];

function postStockMovementRpc(client: { rpc: SupabaseClient<Database>['rpc'] }) {
  return client.rpc.bind(client) as unknown as (
    fn: 'post_stock_movement',
    args: PostStockMovementArgs,
  ) => Promise<{ data: string | null; error: { message: string } | null }>;
}

function createSupabaseAdminClient() {
  return createProtectedSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

// Sets the courier's PHYSICAL stock for a product to an absolute value ("le
// livreur a maintenant X"), replacing the former allocate/return-lot tabs
// (Lot 4b+4c / PR 2). The delta vs. the current physical position is computed
// HERE, server-side — never accept a raw signed delta from the client for this
// gesture (unlike manualAdjustmentAction on /produits, which is delta-based by
// design and stays that way).
//
// Two hard guards, both server-side, both block with no write:
//   - increase (delta > 0) : the central warehouse (product_stock.qty_on_hand)
//     must cover it, else BLOCKED with the exact missing qty.
//   - decrease (delta < 0) : cannot exceed what the driver physically holds,
//     else BLOCKED with the exact excess qty.
// A delta of 0 is a clean no-op (no movement posted, no error).
//
// Posts a single ledger-only `driver_stock_set` movement (0095) — never
// mutates product_stock, same reasoning as order_assignment_commit/release
// (Lot 2) and the PR 1 change to allocate_to_courier/courier_return_lot (0093).
export const setDriverStockAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'drivers.set_driver_stock', section: 'drivers' })
  .inputSchema(
    z.object({
      driverId: z.string().uuid(),
      productId: z.string().uuid(),
      // Pas de .min(0) ici volontairement : un newQty négatif doit atteindre
      // computeDriverStockSetPlan et déclencher le blocage "physique" avec un
      // message détaillé, pas une erreur Zod générique. Un newQty négatif
      // équivaut algébriquement à demander un retrait de -newQty au-delà de 0,
      // quel que soit le stock physique actuel (cf. lib/drivers/driver-stock-set.ts).
      newQty: z.number().int(),
      clientRequestId: z.string().uuid(),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const { driverId, productId, newQty } = parsedInput;
    // Même arité générique SupabaseClient<Database> que resolveOwnerManagerContext
    // (@supabase/ssr vs @supabase/supabase-js) : cast nécessaire pour que .from()
    // résolve les types de colonnes, la valeur runtime est le même client typé.
    const supabase = ctx.supabase as unknown as SupabaseClient<Database>;
    const shopId = await getRequestStoreId();
    if (!shopId) return { ok: false as const, message: 'Boutique active introuvable.' };

    const [{ data: product, error: productError }, { data: driverShop, error: driverShopError }] =
      await Promise.all([
        supabase
          .from('product')
          .select('id')
          .eq('id', productId)
          .eq('merchant_account_id', ctx.member.merchantAccountId)
          .eq('shop_id', shopId)
          .maybeSingle(),
        supabase
          .from('driver_shop')
          .select('driver_id')
          .eq('merchant_account_id', ctx.member.merchantAccountId)
          .eq('shop_id', shopId)
          .eq('driver_id', driverId)
          .maybeSingle(),
      ]);
    if (productError || driverShopError) {
      return {
        ok: false as const,
        message: productError?.message ?? driverShopError?.message ?? 'Lecture impossible.',
      };
    }
    if (!product)
      return { ok: false as const, message: 'Produit introuvable dans la boutique active.' };
    if (!driverShop)
      return { ok: false as const, message: 'Livreur introuvable dans la boutique active.' };

    const { data: movements, error: movementsError } =
      await fetchAllPostgrestRows<DriverStockMovement>(
        async (from, to) =>
          await supabase
            .from('stock_movement')
            .select('driver_id, product_id, movement_type, qty')
            .eq('merchant_account_id', ctx.member.merchantAccountId)
            .eq('shop_id', shopId)
            .eq('driver_id', driverId)
            .eq('product_id', productId)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
      );

    if (movementsError) return { ok: false as const, message: movementsError.message };

    const currentQty =
      driverStockRows((movements ?? []) as DriverStockMovement[], driverId).find(
        (r) => r.productId === productId,
      )?.qtyOnHand ?? 0;

    let centralAvailable = 0;
    if (newQty > currentQty) {
      const { data: stock, error: stockError } = await supabase
        .from('product_stock')
        .select('qty_on_hand')
        .eq('merchant_account_id', ctx.member.merchantAccountId)
        .eq('shop_id', shopId)
        .eq('product_id', productId)
        .maybeSingle();

      if (stockError) return { ok: false as const, message: stockError.message };
      centralAvailable = stock?.qty_on_hand ?? 0;
    }

    const plan = computeDriverStockSetPlan({ currentQty, newQty, centralAvailable });

    if (plan.kind === 'noop') {
      return { ok: true as const, delta: 0 };
    }
    if (plan.kind === 'blocked') {
      return { ok: false as const, shortage: plan };
    }

    const post = postStockMovementRpc(ctx.supabase);
    const { error } = await post('post_stock_movement', {
      p_merchant_account_id: ctx.member.merchantAccountId,
      p_product_id: productId,
      p_movement_type: 'driver_stock_set',
      p_qty: plan.delta,
      p_idempotency_key: `driver_stock_set:${driverId}:${productId}:${parsedInput.clientRequestId}`,
      p_created_by: ctx.user.id,
      p_expected_shop_id: shopId,
      p_driver_id: driverId,
    });

    if (error) return { ok: false as const, message: error.message };
    revalidatePath('/livreurs');
    return { ok: true as const, delta: plan.delta };
  });

export type ActiveDriverOption = { id: string; fullName: string };

// Livreurs actifs proposés par le sélecteur d'affectation, bornés à la BOUTIQUE
// ACTIVE (0133). Avant, cette fonction s'en remettait à la seule RLS de `driver`,
// purement locataire : le sélecteur d'une commande de la boutique B proposait donc
// les livreurs de la boutique A. Read-only, appelée depuis un RSC ; renvoie [] en
// cas d'erreur pour que l'UI dégrade en « aucun livreur actif ».
//
// Sans boutique résolue (appel hors contexte de boutique), on renvoie [] plutôt
// que le parc entier : proposer trop est précisément le défaut corrigé ici.
export async function getActiveDrivers(): Promise<ActiveDriverOption[]> {
  const supabase = await createSupabaseServerClient();
  const shopId = await getRequestStoreId();

  if (!shopId) {
    return [];
  }

  const { data: userData } = await supabase.auth.getUser();
  const user = userData?.user;
  if (!user) {
    return [];
  }

  const { data: member } = await supabase
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  const merchantAccountId = (member as { merchant_account_id: string } | null)?.merchant_account_id;
  if (!merchantAccountId) {
    return [];
  }

  const storeDriverIds = await getStoreDriverIds(
    supabase as unknown as SupabaseClient<Database>,
    merchantAccountId,
    shopId,
  );

  const { data, error } = await supabase
    .from('driver')
    .select('id, full_name')
    .eq('is_active', true)
    .in('id', driverIdFilter(storeDriverIds))
    .order('full_name', { ascending: true });

  if (error || !data) {
    return [];
  }

  const rows = data as { id: string; full_name: string }[];
  return rows.map((driver) => ({ id: driver.id, fullName: driver.full_name }));
}

export type DriverStockRow = {
  productId: string;
  title: string;
  sku: string | null;
  qtyOnHand: number;
};

export type DriverStockData = { ok: true; rows: DriverStockRow[] } | { ok: false; message: string };

// Resolves the current owner/manager context (auth via server client, data via admin).
// `supabase` (client authentifié, cookie-based) est exposé en plus de `admin` : les RPC
// cash (get_driver_cash_consolidation / get_driver_cash_outstanding_orders, migration 0083)
// sont `security definer` avec garde `current_member_role(...)` qui lit `auth.uid()` — un
// appel via le client admin (service-role, sans session) ne verrait aucun `auth.uid()` et
// se ferait rejeter par la garde. Ces RPC DOIVENT être appelées via `supabase`, pas `admin`.
type OwnerManagerContext =
  | {
      ok: true;
      merchantAccountId: string;
      admin: ReturnType<typeof createSupabaseAdminClient>;
      supabase: SupabaseClient<Database>;
    }
  | { ok: false; message: string };

async function resolveOwnerManagerContext(): Promise<OwnerManagerContext> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: 'Session introuvable.' };

  const admin = createSupabaseAdminClient();
  const { data: memberAuth } = await admin
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  if (!memberAuth) return { ok: false, message: 'Compte marchand introuvable.' };
  if (memberAuth.role !== 'owner' && memberAuth.role !== 'manager') {
    return { ok: false, message: 'Accès refusé.' };
  }

  return {
    ok: true,
    merchantAccountId: memberAuth.merchant_account_id,
    admin,
    // @supabase/ssr et @supabase/supabase-js exposent des arités génériques différentes
    // pour SupabaseClient<Database> dans ce repo — même cast que asTypedSupabaseClient
    // (lib/actions/finance.ts), la valeur runtime est le même client typé.
    supabase: supabase as unknown as SupabaseClient<Database>,
  };
}

// Derives the courier's stock-in-hand per product from the ledger (owner/manager only).
export async function getDriverStockOnHand(driverId: string): Promise<DriverStockData> {
  const auth = await resolveOwnerManagerContext();
  if (!auth.ok) return { ok: false, message: auth.message };
  const { merchantAccountId, admin } = auth;

  const { data: movements, error } = await fetchAllPostgrestRows<DriverStockMovement>(
    async (from, to) =>
      await admin
        .from('stock_movement')
        .select('driver_id, product_id, movement_type, qty')
        .eq('merchant_account_id', merchantAccountId)
        .eq('driver_id', driverId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
  );

  if (error) return { ok: false, message: error.message };

  const positions = driverStockRows((movements ?? []) as DriverStockMovement[], driverId).filter(
    (r) => r.qtyOnHand > 0,
  );

  if (positions.length === 0) return { ok: true, rows: [] };

  const { data: products } = await admin
    .from('product')
    .select('id, title, sku')
    .eq('merchant_account_id', merchantAccountId)
    .in(
      'id',
      positions.map((p) => p.productId),
    );

  const productMap = new Map((products ?? []).map((p) => [p.id, p]));

  const rows: DriverStockRow[] = positions
    .map((p) => {
      const product = productMap.get(p.productId);
      return {
        productId: p.productId,
        title: product?.title ?? 'Produit inconnu',
        sku: product?.sku ?? null,
        qtyOnHand: p.qtyOnHand,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title, 'fr'));

  return { ok: true, rows };
}

export type DriverAvailableStockRow = {
  productId: string;
  title: string;
  sku: string | null;
  qtyAvailable: number;
};

export type DriverAvailableStockData =
  | { ok: true; rows: DriverAvailableStockRow[] }
  | { ok: false; message: string };

// Derives the courier's AVAILABLE stock per product (physical hand minus net
// open order-assignment commitments, PR 1 ledger) — owner/manager only.
// Mirror of getDriverStockOnHand above, minus the qtyOnHand > 0 filter:
// available positions can be negative (over-committed courier).
export async function getDriverAvailableStock(driverId: string): Promise<DriverAvailableStockData> {
  const auth = await resolveOwnerManagerContext();
  if (!auth.ok) return { ok: false, message: auth.message };
  const { merchantAccountId, admin } = auth;

  const { data: movements, error } = await fetchAllPostgrestRows<DriverStockMovement>(
    async (from, to) =>
      await admin
        .from('stock_movement')
        .select('driver_id, product_id, movement_type, qty')
        .eq('merchant_account_id', merchantAccountId)
        .eq('driver_id', driverId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
  );

  if (error) return { ok: false, message: error.message };

  const positions = driverAvailableStockRows((movements ?? []) as DriverStockMovement[], driverId);

  if (positions.length === 0) return { ok: true, rows: [] };

  const { data: products } = await admin
    .from('product')
    .select('id, title, sku')
    .eq('merchant_account_id', merchantAccountId)
    .in(
      'id',
      positions.map((p) => p.productId),
    );

  const productMap = new Map((products ?? []).map((p) => [p.id, p]));

  const rows: DriverAvailableStockRow[] = positions
    .map((p) => {
      const product = productMap.get(p.productId);
      return {
        productId: p.productId,
        title: product?.title ?? 'Produit inconnu',
        sku: product?.sku ?? null,
        qtyAvailable: p.qtyAvailable,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title, 'fr'));

  return { ok: true, rows };
}

export type DriverCashData =
  | {
      ok: true;
      consolidation: DriverCashConsolidation;
      periodRemittedMinor: number;
      // Horodatage de lecture serveur du solde live (all-time, jamais périodable
      // — cf. commentaire ci-dessous). Affiché sous la carte "Cash chez le
      // livreur (live)" pour que sa portée (maintenant) ne se confonde jamais
      // avec celle des cartes période (fenêtre choisie). Recalculé à chaque
      // lecture, jamais persisté.
      asOfIso: string;
    }
  | { ok: false; message: string };

const emptyDriverCashConsolidation: DriverCashConsolidation = {
  expectedMinor: 0,
  collectedMinor: 0,
  deliveryFeesMinor: 0,
  collectedDeliveryFeesMinor: 0,
  remittedMinor: 0,
  discrepancyMinor: 0,
  cashOnHandMinor: 0,
};

// Consolidates cash per driver (dû/collecté/remis/écart) via la RPC SQL
// get_driver_cash_consolidation (migration 0083), qui reproduit exactement
// deriveDriverCashConsolidation — plus de select `orders` all-time ni de
// `.in(orderIds)` sur settlement_allocation (cap PostgREST 1000 / URL, #56/#50).
// Owner/manager only (garde côté RPC).
//
// `period` ne scope QUE collecté/frais de livraison (cf. retour porteur : le filtre
// période doit couvrir les cards cash, pas seulement Performance). `cashOnHandMinor`/
// `discrepancyMinor`/`remittedMinor`/`expectedMinor` restent all-time : c'est un solde
// de réconciliation (combien le livreur détient encore de cash non remis EN CE MOMENT),
// pas un rapport périodique — le scoper à une plage donnerait un solde trompeur (ex.
// négatif) qui ne correspond à rien de réel pour un manager qui rapproche le cash.
export async function getDriverCashConsolidation(
  driverId: string,
  period?: { from: string; to: string },
): Promise<DriverCashData> {
  const auth = await resolveOwnerManagerContext();
  if (!auth.ok) return { ok: false, message: auth.message };
  const { merchantAccountId, supabase } = auth;

  const { data, error } = await supabase.rpc('get_driver_cash_consolidation', {
    p_merchant_id: merchantAccountId,
    p_driver_id: driverId,
    p_period_from: period?.from,
    p_period_to: period?.to,
  });

  if (error) return { ok: false, message: error.message };

  const row = data?.[0];
  if (!row) {
    // Livreur sans commande assignée : mêmes zéros que l'ancien code (tableau
    // d'orders vide → deriveDriverCashConsolidation renvoyait déjà des zéros).
    return {
      ok: true,
      consolidation: emptyDriverCashConsolidation,
      periodRemittedMinor: 0,
      asOfIso: new Date().toISOString(),
    };
  }

  return {
    ok: true,
    consolidation: {
      expectedMinor: row.expected_minor,
      collectedMinor: period ? row.period_collected_minor : row.collected_minor,
      deliveryFeesMinor: period ? row.period_delivery_fees_minor : row.delivery_fees_minor,
      collectedDeliveryFeesMinor: period
        ? row.period_collected_delivery_fees_minor
        : row.collected_delivery_fees_minor,
      remittedMinor: row.remitted_minor,
      discrepancyMinor: row.cash_on_hand_minor,
      cashOnHandMinor: row.cash_on_hand_minor,
    },
    // Carte "(période)" (migration 0100) : versements enregistrés sur la fenêtre
    // sélectionnée (settlement_allocation.created_at), distinct de remittedMinor
    // (all-time). Zéro si aucune période n'est fournie (garde SQL sur p_period_from/to).
    periodRemittedMinor: row.period_remitted_minor,
    asOfIso: new Date().toISOString(),
  };
}

export type DriverPerformanceData =
  | { ok: true; performance: DriverPerformance }
  | { ok: false; message: string };

// Per-driver performance over a period (created_at in [from, to)). Owner/manager only.
export async function getDriverPerformance(
  driverId: string,
  period: { from: string; to: string },
): Promise<DriverPerformanceData> {
  const auth = await resolveOwnerManagerContext();
  if (!auth.ok) return { ok: false, message: auth.message };
  const { merchantAccountId, admin } = auth;

  const { data: orders, error } = await admin
    .from('orders')
    .select(
      'cod_status, cash_state, cash_collectable_minor, payment_channel_at_delivery, total_amount',
    )
    .eq('merchant_account_id', merchantAccountId)
    .eq('assigned_driver_id', driverId)
    .gte('created_at', period.from)
    .lt('created_at', period.to);

  if (error) return { ok: false, message: error.message };

  const performance = deriveDriverPerformance(
    (orders ?? []).map((o) => ({
      codStatus: o.cod_status,
      cashState: o.cash_state,
      cashCollectableMinor: o.cash_collectable_minor,
      paymentChannel: o.payment_channel_at_delivery,
      totalAmount: o.total_amount,
    })),
  );

  return { ok: true, performance };
}

// Résout les noms d'auteur (created_by) via l'auth admin, dédupliqués. Few authors
// en pratique (owner + managers) → un getUserById par id distinct suffit.
async function resolveAuthorNames(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userIds: (string | null)[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const distinct = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  await Promise.all(
    distinct.map(async (id) => {
      const { data } = await admin.auth.admin.getUserById(id);
      const meta = (data.user?.user_metadata ?? {}) as Record<string, unknown>;
      const fromMeta =
        (typeof meta.full_name === 'string' && meta.full_name) ||
        (typeof meta.name === 'string' && meta.name) ||
        '';
      names.set(id, fromMeta || data.user?.email || 'Inconnu');
    }),
  );
  return names;
}

export type SettlementHistoryRow = {
  id: string;
  settledAt: string; // ISO
  amountMinor: number; // peut être négatif (reprise de retour, 0056)
  method: string;
  driverId: string | null;
  driverName: string;
  authorName: string;
};

export type SettlementHistoryData =
  | { ok: true; rows: SettlementHistoryRow[] }
  | { ok: false; message: string };

type RawSettlementRow = {
  id: string;
  driver_id: string | null;
  amount_received_minor: number;
  method: string;
  settled_at: string;
  created_by: string | null;
};

// Construit l'historique des versements depuis cash_settlement (trié par date desc),
// avec nom du livreur et auteur résolus. Owner/manager. `driverId` null = tous livreurs.
async function buildSettlementHistory(driverId: string | null): Promise<SettlementHistoryData> {
  const auth = await resolveOwnerManagerContext();
  if (!auth.ok) return { ok: false, message: auth.message };
  const { merchantAccountId, admin } = auth;

  let query = admin
    .from('cash_settlement')
    .select('id, driver_id, amount_received_minor, method, settled_at, created_by')
    .eq('merchant_account_id', merchantAccountId)
    .order('settled_at', { ascending: false });
  if (driverId) query = query.eq('driver_id', driverId);

  const { data, error } = await query;
  if (error) return { ok: false, message: error.message };

  const settlements = (data ?? []) as RawSettlementRow[];
  if (settlements.length === 0) return { ok: true, rows: [] };

  const driverIds = [...new Set(settlements.map((s) => s.driver_id).filter(Boolean))] as string[];
  const { data: drivers } = await admin
    .from('driver')
    .select('id, full_name')
    .eq('merchant_account_id', merchantAccountId)
    .in('id', driverIds.length > 0 ? driverIds : ['00000000-0000-0000-0000-000000000000']);
  const driverNames = new Map((drivers ?? []).map((d) => [d.id, d.full_name]));

  const authorNames = await resolveAuthorNames(
    admin,
    settlements.map((s) => s.created_by),
  );

  const rows: SettlementHistoryRow[] = settlements.map((s) => ({
    id: s.id,
    settledAt: s.settled_at,
    amountMinor: s.amount_received_minor,
    method: s.method,
    driverId: s.driver_id,
    driverName: (s.driver_id && driverNames.get(s.driver_id)) || 'Livreur',
    authorName: (s.created_by && authorNames.get(s.created_by)) || 'Inconnu',
  }));

  return { ok: true, rows };
}

// Historique des versements d'un livreur (owner/manager).
export async function getDriverSettlementHistory(driverId: string): Promise<SettlementHistoryData> {
  return buildSettlementHistory(driverId);
}

// Historique global des versements, tous livreurs consolidés (owner/manager).
export async function getAllSettlementHistory(): Promise<SettlementHistoryData> {
  return buildSettlementHistory(null);
}

export type DriversCashTotal =
  | { ok: true; totalMinor: number; driverCount: number }
  | { ok: false; message: string };

// Cash total « à remettre » chez TOUS les livreurs = Σ cashOnHand par livreur
// (collecté − frais encaissés − remis), via la RPC get_driver_cash_consolidation
// (migration 0083) qui porte la même arithmétique agrégée que le panneau Livreurs
// et le panneau Finances → aucun chiffre dupliqué. Owner/manager (garde côté RPC).
export async function getDriversCashOnHandTotal(shopId?: string | null): Promise<DriversCashTotal> {
  const auth = await resolveOwnerManagerContext();
  if (!auth.ok) return { ok: false, message: auth.message };
  const { merchantAccountId, supabase } = auth;

  const { data, error } = await supabase.rpc('get_driver_cash_consolidation', {
    p_merchant_id: merchantAccountId,
    ...(shopId ? { p_shop_id: shopId } : {}),
  });
  if (error) return { ok: false, message: error.message };

  let totalMinor = 0;
  let driverCount = 0;
  for (const row of data ?? []) {
    totalMinor += row.cash_on_hand_minor;
    if (row.cash_on_hand_minor > 0) driverCount += 1;
  }

  return { ok: true, totalMinor, driverCount };
}
