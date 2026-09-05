// Corrige le P0 U0-D2 "Valeur totale du stock" : deux défauts cumulés dans
// l'ancien calcul client (components/stock/stock-table.tsx avant ce lot) —
// (1) unit_cost ?? 0 confondait "jamais coûté" et "coûté à zéro" (violation
// du contrat "manquant ≠ zéro"), (2) l'agrégat était recalculé côté React
// sur les 25 lignes déjà chargées, jamais sur le catalogue entier.
//
// Fix : une seule lecture serveur, paginée via fetchAllPostgrestRows (même
// mécanisme que lib/actions/drivers.ts pour le même plafond PostgREST
// max_rows=1000), qui nourrit à la fois le total, le compteur "stock bas" et
// la population que l'alerte ouvre — un seul prédicat, jamais trois lectures
// divergentes.
import type { Database } from '@/lib/supabase/database.types';
import { fetchAllPostgrestRows } from '@/lib/supabase/pagination';
import type { SupabaseClient } from '@supabase/supabase-js';

export type StockCatalogRow = {
  productId: string;
  qtyOnHand: number;
  qtyReserved: number;
  unitCost: number;
  lowStockThreshold: number;
  isBundle: boolean;
};

export type StockCatalogSummary = {
  // null = rien de calculable (aucun produit non-bundle avec un coût connu et une quantité).
  totalValueMinor: number | null;
  // Produits non-bundle avec qty_on_hand > 0 et un coût jamais saisi (unit_cost <= 0).
  costUnknownCount: number;
  lowStockCount: number;
  lowStockProductIds: string[];
};

// Même convention que lib/finance/product-cost.ts:34 (costMissing = unitCost <= 0) —
// product_stock.unit_cost est `bigint not null default 0`, jamais null : un coût
// jamais saisi et un coût réellement nul partagent la même valeur en base, la
// distinction est purement conventionnelle, déjà tranchée ailleurs dans ce projet.
export function isStockCostMissing(unitCost: number): boolean {
  return unitCost <= 0;
}

// Seule et unique définition de "stock bas" du projet — DOIT rester la formule
// utilisée par lib/actions/products.ts (ProductsPageItem.isLowStock,
// getProductsPageData ET loadMoreProductsAction) pour que le compteur/l'alerte
// de ce module et le badge affiché sur chaque ligne ne divergent jamais.
// Importer cette fonction plutôt que de réécrire `qtyOnHand <= threshold`
// ailleurs.
export function isRowLowStock(qtyOnHand: number, lowStockThreshold: number): boolean {
  return qtyOnHand <= lowStockThreshold;
}

export function computeStockCatalogSummary(rows: StockCatalogRow[]): StockCatalogSummary {
  const sellable = rows.filter((r) => !r.isBundle);

  let totalValueMinor: number | null = null;
  let costUnknownCount = 0;
  const lowStockProductIds: string[] = [];

  for (const r of sellable) {
    // Règle : qty_on_hand = 0 vaut zéro, quel que soit le coût — rien à
    // valoriser, ce n'est jamais un "coût manquant". Seul un coût manquant
    // AVEC un stock positif rend la valeur non calculable pour cette ligne.
    if (r.qtyOnHand === 0) {
      totalValueMinor = (totalValueMinor ?? 0) + 0;
    } else if (isStockCostMissing(r.unitCost)) {
      costUnknownCount += 1;
    } else {
      totalValueMinor = (totalValueMinor ?? 0) + r.qtyOnHand * r.unitCost;
    }
    if (isRowLowStock(r.qtyOnHand, r.lowStockThreshold)) {
      lowStockProductIds.push(r.productId);
    }
  }

  return {
    totalValueMinor,
    costUnknownCount,
    lowStockCount: lowStockProductIds.length,
    lowStockProductIds,
  };
}

export async function fetchStockCatalogRows(
  admin: SupabaseClient<Database>,
  merchantAccountId: string,
  shopId: string,
): Promise<{ ok: true; rows: StockCatalogRow[] } | { ok: false; message: string }> {
  type ProductRow = { id: string; is_bundle: boolean };
  const { data: products, error: productError } = await fetchAllPostgrestRows<ProductRow>(
    async (from, to) =>
      await admin
        .from('product')
        .select('id, is_bundle')
        .eq('merchant_account_id', merchantAccountId)
        .eq('shop_id', shopId)
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, to),
  );
  if (productError) return { ok: false, message: productError.message };

  type ProductStockRow = {
    product_id: string;
    qty_on_hand: number;
    qty_reserved: number;
    unit_cost: number;
    low_stock_threshold: number;
  };
  const { data: stocks, error: stockError } = await fetchAllPostgrestRows<ProductStockRow>(
    async (from, to) =>
      await admin
        .from('product_stock')
        .select('product_id, qty_on_hand, qty_reserved, unit_cost, low_stock_threshold')
        .eq('merchant_account_id', merchantAccountId)
        .eq('shop_id', shopId)
        .order('product_id', { ascending: true })
        .range(from, to),
  );
  if (stockError) return { ok: false, message: stockError.message };

  const stockMap = new Map(stocks.map((s) => [s.product_id, s]));

  const rows: StockCatalogRow[] = products.map((p) => {
    const s = stockMap.get(p.id);
    return {
      productId: p.id,
      qtyOnHand: s?.qty_on_hand ?? 0,
      qtyReserved: s?.qty_reserved ?? 0,
      unitCost: s?.unit_cost ?? 0,
      lowStockThreshold: s?.low_stock_threshold ?? 10,
      isBundle: p.is_bundle,
    };
  });

  return { ok: true, rows };
}
