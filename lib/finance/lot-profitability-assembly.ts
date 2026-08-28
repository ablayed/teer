// Lot F2 — Assemble la sortie brute (agrégats seulement) de la RPC
// get_purchase_lot_profitability avec le moteur pur de F1
// (lib/finance/lot-profitability.ts). Zéro accès base, zéro import
// `env`/Supabase ici — pure et testable sans base, même contrat que F1.
import {
  type AllocationMethod,
  type LotProductLine,
  type LotProductProfitability,
  computeLotProductProfitability,
  isAllocationMethodAvailable,
} from '@/lib/finance/lot-profitability';

export type PurchaseLotProfitabilityRpcRow = {
  purchaseLotLineId: string;
  productId: string;
  qtyReceived: number;
  qtySold: number;
  purchaseValueMinor: number;
  weightGrams: number | null;
  cashCollectedMinor: number;
  adSpendMinor: number;
};

export type PurchaseLotProfitabilityRpcResult = {
  purchaseLotId: string;
  transportTotalMinor: number;
  transportComplete: boolean;
  allocationMethod: AllocationMethod;
  lines: PurchaseLotProfitabilityRpcRow[];
};

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
  | { ok: false; reason: 'not_found' };

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

  const lines: PurchaseLotLineProfitability[] = rpc.lines.map((row) => {
    const line = toLotProductLine(row);
    const profitability = computeLotProductProfitability({
      line,
      allLinesInLot: allLines,
      allocationMethod: rpc.allocationMethod,
      transportTotalMinor: rpc.transportTotalMinor,
      transportComplete: rpc.transportComplete,
      cashCollectedMinor: row.cashCollectedMinor,
      adSpend: { valueMinor: row.adSpendMinor, complete: true },
    });
    return { ...profitability, productId: row.productId, purchaseLotLineId: row.purchaseLotLineId };
  });

  const missingInputs = [...new Set(lines.flatMap((l) => l.missingInputs))];
  const totals: PurchaseLotProfitabilityTotals = {
    cashCollectedMinor: rpc.lines.reduce((s, r) => s + r.cashCollectedMinor, 0),
    costOfSoldMinor: lines.reduce((s, l) => s + l.costOfSoldMinor, 0),
    adSpendMinor: rpc.lines.reduce((s, r) => s + r.adSpendMinor, 0),
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
