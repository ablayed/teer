// Lot F2 — Assemble la sortie brute (agrégats seulement) de la RPC
// get_purchase_lot_profitability avec le moteur pur de F1
// (lib/finance/lot-profitability.ts). Zéro accès base, zéro import
// `env`/Supabase ici — pure et testable sans base, même contrat que F1.
import {
  type AllocationMethod,
  type LotProductLine,
  type LotProductProfitability,
  computeLotProductProfitability,
  distributeByLargestRemainder,
  isAllocationMethodAvailable,
} from '@/lib/finance/lot-profitability';
import { z } from 'zod';

// La RPC déclare `returns jsonb` (0146) : `database.types.ts` la type donc en
// `Json` générique, jamais en la forme réelle qu'elle renvoie — un cast
// affirmerait cette forme sans la vérifier (silencieux si la RPC change de
// structure un jour). Ce schéma zod EST le contrat lisible de ce que la RPC
// rend ; les types TS s'en déduisent (`z.infer`), jamais l'inverse.
export const purchaseLotProfitabilityRpcRowSchema = z.object({
  purchaseLotLineId: z.string(),
  productId: z.string(),
  qtyReceived: z.number(),
  qtySold: z.number(),
  purchaseValueMinor: z.number(),
  weightGrams: z.number().nullable(),
  cashCollectedMinor: z.number(),
});

export type PurchaseLotProfitabilityRpcRow = z.infer<typeof purchaseLotProfitabilityRpcRowSchema>;

/** Total de publicité par PRODUIT (jamais par ligne) — la RPC n'agrège que. */
export const purchaseLotProductAdSpendSchema = z.object({
  productId: z.string(),
  amountMinor: z.number(),
});

export type PurchaseLotProductAdSpend = z.infer<typeof purchaseLotProductAdSpendSchema>;

export const purchaseLotProfitabilityRpcResultSchema = z.object({
  purchaseLotId: z.string(),
  transportTotalMinor: z.number(),
  transportComplete: z.boolean(),
  allocationMethod: z.enum(['value', 'quantity', 'weight']) satisfies z.ZodType<AllocationMethod>,
  lines: z.array(purchaseLotProfitabilityRpcRowSchema),
  productAdSpend: z.array(purchaseLotProductAdSpendSchema),
});

export type PurchaseLotProfitabilityRpcResult = z.infer<
  typeof purchaseLotProfitabilityRpcResultSchema
>;

/**
 * Répartit la publicité totale de chaque produit entre ses lignes de CE lot,
 * au prorata de `qtyReceived`, par la méthode du plus grand reste
 * (`distributeByLargestRemainder`, seule implémentation du domaine Finances
 * v2 / lot-profitability — cf. lib/finance/lot-profitability.ts ; distincte
 * de la fonction homonyme bigint de lib/purchases/fee-allocation.ts, qui a
 * une sémantique poids-nul différente et ne doit pas être fusionnée). Un
 * produit avec une seule ligne dans ce lot reçoit trivialement 100 % de sa
 * publicité sur cette ligne : l'algorithme
 * général le fait naturellement (poids unique = totalWeight, part = total),
 * vérifié par test plutôt que spécial-casé.
 *
 * Poids tous nuls pour un produit (toutes ses lignes à qtyReceived=0) : repli
 * sur des poids égaux (même principe que `allocateTransportCost`) pour que la
 * publicité du produit reste répartie et que la somme des parts égale
 * toujours exactement son total, plutôt que de la perdre silencieusement.
 */
function computeAdSpendByLine(
  rows: PurchaseLotProfitabilityRpcRow[],
  productAdSpend: PurchaseLotProductAdSpend[],
): Map<string, number> {
  const totalByProduct = new Map(productAdSpend.map((p) => [p.productId, p.amountMinor]));
  const linesByProduct = new Map<string, PurchaseLotProfitabilityRpcRow[]>();
  for (const row of rows) {
    const list = linesByProduct.get(row.productId);
    if (list) {
      list.push(row);
    } else {
      linesByProduct.set(row.productId, [row]);
    }
  }

  const result = new Map<string, number>();
  for (const [productId, productLines] of linesByProduct) {
    const total = totalByProduct.get(productId) ?? 0;
    const weights = productLines.map((row) => row.qtyReceived);
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const effectiveWeights = totalWeight > 0 ? weights : productLines.map(() => 1);
    const shares = distributeByLargestRemainder(effectiveWeights, total);
    productLines.forEach((row, index) => result.set(row.purchaseLotLineId, shares[index]));
  }

  return result;
}

export type PurchaseLotLineProfitability = LotProductProfitability & {
  purchaseLotLineId: string;
};

export type PurchaseLotProfitabilityTotals = {
  cashCollectedMinor: number;
  costOfSoldMinor: number;
  adSpendMinor: number;
  marginMinor: number;
  marginPct: number;
  complete: boolean;
  missingInputs: string[];
  unsoldUnits: number;
  unsoldCostEngagedMinor: number;
  qtyReceived: number;
  qtySold: number;
};

export type PurchaseLotProfitabilitySummary =
  | {
      ok: true;
      allocationMethodAvailable: true;
      allocationMethod: AllocationMethod;
      lines: PurchaseLotLineProfitability[];
      totals: PurchaseLotProfitabilityTotals;
    }
  | {
      ok: true;
      allocationMethodAvailable: false;
      reason: 'missing_weight';
      allocationMethod: AllocationMethod;
    }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'error' };

function toLotProductLine(row: PurchaseLotProfitabilityRpcRow): LotProductLine {
  return {
    productId: row.purchaseLotLineId, // clé d'allocation transport = LA LIGNE, jamais le produit (deux lignes du même produit dans un même lot sont possibles en théorie et doivent rester distinctes)
    qtyReceived: row.qtyReceived,
    qtySold: row.qtySold,
    purchaseValueMinor: row.purchaseValueMinor,
    weightGrams: row.weightGrams,
  };
}

export function assemblePurchaseLotProfitability(
  rpc: PurchaseLotProfitabilityRpcResult | null,
): PurchaseLotProfitabilitySummary {
  if (!rpc) {
    return { ok: false, reason: 'not_found' };
  }

  const allLines = rpc.lines.map(toLotProductLine);
  const availability = isAllocationMethodAvailable(allLines, rpc.allocationMethod);
  if (!availability.available) {
    return {
      ok: true,
      allocationMethodAvailable: false,
      reason: availability.reason ?? 'missing_weight',
      allocationMethod: rpc.allocationMethod,
    };
  }

  const adSpendByLine = computeAdSpendByLine(rpc.lines, rpc.productAdSpend);

  const lines: PurchaseLotLineProfitability[] = rpc.lines.map((row) => {
    const line = toLotProductLine(row);
    const adSpendMinor = adSpendByLine.get(row.purchaseLotLineId) ?? 0;
    const profitability = computeLotProductProfitability({
      line,
      allLinesInLot: allLines,
      allocationMethod: rpc.allocationMethod,
      transportTotalMinor: rpc.transportTotalMinor,
      transportComplete: rpc.transportComplete,
      cashCollectedMinor: row.cashCollectedMinor,
      adSpend: { valueMinor: adSpendMinor, complete: true },
    });
    return { ...profitability, productId: row.productId, purchaseLotLineId: row.purchaseLotLineId };
  });

  const missingInputs = [...new Set(lines.flatMap((l) => l.missingInputs))];
  const totals: PurchaseLotProfitabilityTotals = {
    cashCollectedMinor: rpc.lines.reduce((s, r) => s + r.cashCollectedMinor, 0),
    costOfSoldMinor: lines.reduce((s, l) => s + l.costOfSoldMinor, 0),
    adSpendMinor: [...adSpendByLine.values()].reduce((s, v) => s + v, 0),
    marginMinor: lines.reduce((s, l) => s + l.marginMinor, 0),
    marginPct: 0,
    complete: missingInputs.length === 0,
    missingInputs,
    unsoldUnits: lines.reduce((s, l) => s + l.unsoldUnits, 0),
    unsoldCostEngagedMinor: lines.reduce((s, l) => s + l.unsoldCostEngagedMinor, 0),
    qtyReceived: rpc.lines.reduce((s, r) => s + r.qtyReceived, 0),
    qtySold: rpc.lines.reduce((s, r) => s + r.qtySold, 0),
  };
  totals.marginPct =
    totals.cashCollectedMinor === 0 ? 0 : totals.marginMinor / totals.cashCollectedMinor;

  return {
    ok: true,
    allocationMethodAvailable: true,
    allocationMethod: rpc.allocationMethod,
    lines,
    totals,
  };
}
