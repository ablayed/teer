// Lot F1 — Socle de données Finances v2. Moteur de calcul PUR (aucun accès
// base, aucun import de `env`/Supabase — testable sans base, cf. CLAUDE.md
// « Le calcul »).
//
// Principe directeur : « entrées stockées, résultats DÉRIVÉS » pour les coûts.
// Rien ici n'est persisté — un changement de méthode de répartition ou une
// correction de coût ne fait que rappeler ces fonctions avec des entrées
// différentes ; aucune migration de données, aucun montant figé.
//
// Montants en XOF, entiers, 0 décimale — jamais de flottant sur un montant
// (convention du projet, cf. lib/format/fcfa.ts : les montants sont des
// `number` entiers, jamais des `bigint`, le domaine FCFA restant très en deçà
// de Number.MAX_SAFE_INTEGER). Les arrondis de répartition sont déterministes
// et leur somme égale exactement le total réparti (méthode du plus grand
// reste / Hamilton).

export type AllocationMethod = 'value' | 'quantity' | 'weight';

export interface LotProductLine {
  productId: string;
  /** Quantité reçue à l'arrivage (> 0). */
  qtyReceived: number;
  /** Quantité reconnue vendue pour ce produit sur cet arrivage (0..qtyReceived). */
  qtySold: number;
  /** purchase_lot_line.purchase_price_total — prix d'achat de la ligne. */
  purchaseValueMinor: number;
  /** purchase_lot_line.weight_grams — null si non renseigné. */
  weightGrams: number | null;
}

export interface CostEntry {
  valueMinor: number;
  /** false = coût pas encore connu — la marge sera provisoire. */
  complete: boolean;
}

export interface AllocationAvailability {
  available: boolean;
  reason?: 'missing_weight';
}

/**
 * La méthode 'weight' n'est disponible que si TOUTES les lignes de l'arrivage
 * portent un poids. Ne propose jamais une méthode dont la donnée manque
 * (décision du fondateur) — l'appelant (F2) doit interroger cette fonction
 * avant d'offrir le choix à l'écran.
 */
export function isAllocationMethodAvailable(
  lines: Pick<LotProductLine, 'weightGrams'>[],
  method: AllocationMethod,
): AllocationAvailability {
  if (method !== 'weight') {
    return { available: true };
  }

  const missingWeight = lines.some(
    (line) => line.weightGrams === null || line.weightGrams === undefined,
  );

  return missingWeight ? { available: false, reason: 'missing_weight' } : { available: true };
}

export interface TransportAllocationResult {
  productId: string;
  allocatedTransportMinor: number;
}

/**
 * Répartit `transportTotalMinor` entre les lignes de l'arrivage selon
 * `method`. Méthode du plus grand reste : chaque ligne reçoit d'abord le
 * plancher de sa part proportionnelle, puis le reliquat (toujours < nombre de
 * lignes) est distribué une unité à la fois aux plus grands restes — la somme
 * des parts égale TOUJOURS exactement `transportTotalMinor`, y compris sur des
 * totaux premiers ou des restes non nuls.
 *
 * Pure — ne lit ni n'écrit rien. Changer `method` change le résultat sans
 * migration de données (aucun état stocké).
 */
export function allocateTransportCost(
  lines: LotProductLine[],
  method: AllocationMethod,
  transportTotalMinor: number,
): TransportAllocationResult[] {
  if (lines.length === 0) {
    return [];
  }

  if (!Number.isInteger(transportTotalMinor) || transportTotalMinor < 0) {
    throw new RangeError(
      'allocateTransportCost: transportTotalMinor must be a non-negative integer',
    );
  }

  const availability = isAllocationMethodAvailable(lines, method);
  if (!availability.available) {
    throw new Error(`allocation_method_unavailable:${availability.reason}`);
  }

  const weights = lines.map((line) => {
    switch (method) {
      case 'quantity':
        return line.qtyReceived;
      case 'value':
        return line.purchaseValueMinor;
      case 'weight':
        return line.weightGrams ?? 0;
    }
  });

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  // Aucune base de répartition exploitable (ex. toutes les valeurs à zéro) :
  // répartit à parts égales plutôt que de diviser par zéro — reste une
  // répartition déterministe dont la somme égale le total.
  const effectiveWeights = totalWeight > 0 ? weights : lines.map(() => 1);

  const shares = distributeByLargestRemainder(effectiveWeights, transportTotalMinor);

  return lines.map((line, index) => ({
    productId: line.productId,
    allocatedTransportMinor: shares[index],
  }));
}

/**
 * Répartit `total` (entier, >= 0) entre `weights.length` parts au prorata de
 * `weights` (poids >= 0, pas nécessairement entiers) par la méthode du plus
 * grand reste (Hamilton) : plancher entier par part, puis le reliquat
 * (toujours < weights.length) distribué une unité à la fois aux plus grands
 * restes, index d'origine croissant en cas d'égalité. La somme des parts
 * renvoyées égale TOUJOURS exactement `total`.
 *
 * SEULE implémentation du plus grand reste du projet — `allocateTransportCost`
 * (répartition du transport) et la proratisation de la publicité par ligne
 * (lib/finance/lot-profitability-assembly.ts, Lot F2) l'appellent toutes les
 * deux plutôt que de réimplémenter la technique une seconde fois (une
 * réimplémentation en SQL a divergé une fois : `sum(bigint)` renvoie
 * `numeric`, cassant la troncature entière — cf. migration 0146).
 *
 * Poids tous nuls (totalWeight=0) : renvoie des zéros partout — c'est
 * l'appelant qui décide d'un repli (ex. poids égaux) avant d'appeler cette
 * fonction si une répartition non nulle est requise malgré des poids nuls.
 */
export function distributeByLargestRemainder(weights: number[], total: number): number[] {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  if (totalWeight === 0) {
    return weights.map(() => 0);
  }

  const floors: number[] = [];
  const remainders: number[] = [];
  let allocatedSoFar = 0;

  for (const w of weights) {
    const scaled = total * w;
    const share = Math.floor(scaled / totalWeight);
    const remainder = scaled - share * totalWeight;
    floors.push(share);
    remainders.push(remainder);
    allocatedSoFar += share;
  }

  let leftover = total - allocatedSoFar;

  // Ordre déterministe : plus grand reste d'abord ; égalité tranchée par
  // l'index d'origine (croissant) — jamais l'ordre de tri du moteur JS laissé
  // implicite.
  const order = weights
    .map((_, index) => index)
    .sort((a, b) => (remainders[b] !== remainders[a] ? remainders[b] - remainders[a] : a - b));

  for (let k = 0; k < order.length && leftover > 0; k++) {
    floors[order[k]] += 1;
    leftover -= 1;
  }

  return floors;
}

/** Arrondi déterministe au plus proche entier (moitié vers le haut), sur des opérandes >= 0. */
function roundDiv(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

export interface LandedCostResult {
  productId: string;
  /** prix d'achat de la ligne + part de transport allouée. */
  landedTotalMinor: number;
  /** coût de revient rendu, par unité — landedTotalMinor / qtyReceived. */
  landedUnitCostMinor: number;
}

export function computeLandedCost(
  line: LotProductLine,
  allocatedTransportMinor: number,
): LandedCostResult {
  const landedTotalMinor = line.purchaseValueMinor + allocatedTransportMinor;
  const landedUnitCostMinor =
    line.qtyReceived > 0 ? Math.floor(landedTotalMinor / line.qtyReceived) : 0;

  return { productId: line.productId, landedTotalMinor, landedUnitCostMinor };
}

/** coût de revient des unités vendues = coût du lot × (quantité vendue ÷ quantité reçue). */
export function computeCostOfSold(
  landedTotalMinor: number,
  qtyReceived: number,
  qtySold: number,
): number {
  if (qtyReceived <= 0) {
    return 0;
  }
  return roundDiv(landedTotalMinor * qtySold, qtyReceived);
}

export interface MarginInput {
  /** CA encaissé — déjà net des frais de livraison (déduits au niveau commande, jamais réparti). */
  cashCollectedMinor: number;
  costOfSoldMinor: number;
  adSpend: CostEntry;
  /** false = transport pas encore connu pour ce lot — marge provisoire. */
  transportComplete: boolean;
}

export interface MarginResult {
  marginMinor: number;
  /** Ratio (0.219 = 21,9 %), jamais un montant — flottant autorisé ici. */
  marginPct: number;
  complete: boolean;
  missingInputs: string[];
}

/**
 * Marge = CA encaissé − coût de revient des vendus − dépenses publicitaires.
 * Toujours calculée sur les coûts CONNUS : une entrée manquante (transport pas
 * encore connu, publicité pas encore saisie) n'empêche pas le calcul, elle
 * marque seulement le résultat `complete: false` en nommant l'entrée
 * manquante — jamais « la marge est fausse », toujours « calculée sur les
 * coûts connus ».
 */
export function computeMargin(input: MarginInput): MarginResult {
  const missingInputs: string[] = [];
  if (!input.transportComplete) {
    missingInputs.push('transport_total');
  }
  if (!input.adSpend.complete) {
    missingInputs.push('ad_spend');
  }

  const marginMinor = input.cashCollectedMinor - input.costOfSoldMinor - input.adSpend.valueMinor;
  const marginPct = input.cashCollectedMinor === 0 ? 0 : marginMinor / input.cashCollectedMinor;

  return {
    marginMinor,
    marginPct,
    complete: missingInputs.length === 0,
    missingInputs,
  };
}

export interface LotProductProfitabilityInput {
  line: LotProductLine;
  /** Toutes les lignes de l'arrivage (nécessaire pour répartir le transport). */
  allLinesInLot: LotProductLine[];
  allocationMethod: AllocationMethod;
  transportTotalMinor: number;
  transportComplete: boolean;
  cashCollectedMinor: number;
  adSpend: CostEntry;
}

export interface LotProductProfitability {
  productId: string;
  allocatedTransportMinor: number;
  landedTotalMinor: number;
  landedUnitCostMinor: number;
  costOfSoldMinor: number;
  /** null si aucune vente (ratio non défini), jamais 0 par défaut silencieux. */
  adSpendPerUnitMinor: number | null;
  unsoldUnits: number;
  /** invendu : coût de revient déjà engagé sur les unités restantes. */
  unsoldCostEngagedMinor: number;
  marginMinor: number;
  marginPct: number;
  complete: boolean;
  missingInputs: string[];
}

/** Assemble répartition transport → coût de revient → coût des vendus → marge, en un seul appel. */
export function computeLotProductProfitability(
  input: LotProductProfitabilityInput,
): LotProductProfitability {
  const allocations = allocateTransportCost(
    input.allLinesInLot,
    input.allocationMethod,
    input.transportTotalMinor,
  );
  const mine = allocations.find((a) => a.productId === input.line.productId);

  if (!mine) {
    throw new Error('computeLotProductProfitability: line.productId not found in allLinesInLot');
  }

  const landed = computeLandedCost(input.line, mine.allocatedTransportMinor);
  const costOfSoldMinor = computeCostOfSold(
    landed.landedTotalMinor,
    input.line.qtyReceived,
    input.line.qtySold,
  );
  const margin = computeMargin({
    cashCollectedMinor: input.cashCollectedMinor,
    costOfSoldMinor,
    adSpend: input.adSpend,
    transportComplete: input.transportComplete,
  });

  const unsoldUnits = Math.max(0, input.line.qtyReceived - input.line.qtySold);
  const adSpendPerUnitMinor =
    input.line.qtySold > 0 ? roundDiv(input.adSpend.valueMinor, input.line.qtySold) : null;

  return {
    productId: input.line.productId,
    allocatedTransportMinor: mine.allocatedTransportMinor,
    landedTotalMinor: landed.landedTotalMinor,
    landedUnitCostMinor: landed.landedUnitCostMinor,
    costOfSoldMinor,
    adSpendPerUnitMinor,
    unsoldUnits,
    unsoldCostEngagedMinor: landed.landedUnitCostMinor * unsoldUnits,
    marginMinor: margin.marginMinor,
    marginPct: margin.marginPct,
    complete: margin.complete,
    missingInputs: margin.missingInputs,
  };
}
