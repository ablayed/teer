// Répartition des frais partagés d'un lot fournisseur par la méthode
// du plus grand reste (Largest Remainder Method), au prorata de la valeur
// d'achat. Arithmétique entière (bigint) : la somme des frais alloués est
// toujours égale au total exact — aucun franc perdu ou créé.

export type FeeAllocationLine = {
  qty: number;
  unitPurchasePrice: number; // en FCFA (minor units, entier)
};

export type AllocatedLine = {
  lineValue: number; // qty × unitPurchasePrice
  allocatedFees: number; // frais partagés alloués à cette ligne
  landedTotalValue: number; // lineValue + allocatedFees (valeur atterrie exacte)
  landedUnitCost: number; // floor(landedTotalValue / qty), 0 si qty = 0
};

// Distribue `feeTotal` entre les lignes proportionnellement à leurs `weights`.
// Garantit : Σ résultat = feeTotal (plus grand reste pour les francs restants).
// Tie-break : index de ligne croissant (déterministe).
// Si totalWeight = 0 : répartition égale entre toutes les lignes.
function distributeByLargestRemainder(
  feeTotal: bigint,
  weights: bigint[],
  totalWeight: bigint,
): bigint[] {
  const n = weights.length;
  if (n === 0) return [];
  if (feeTotal === 0n) return new Array<bigint>(n).fill(0n);

  if (totalWeight === 0n) {
    const floor = feeTotal / BigInt(n);
    const leftover = Number(feeTotal - floor * BigInt(n));
    return Array.from({ length: n }, (_, i) => floor + (i < leftover ? 1n : 0n));
  }

  const floors: bigint[] = weights.map((w) => (feeTotal * w) / totalWeight);
  // reste = feeTotal*w - floor*totalWeight (évite la dérive flottante)
  const remainders: bigint[] = weights.map((w, i) => feeTotal * w - floors[i] * totalWeight);

  const leftover = Number(feeTotal - floors.reduce((a, b) => a + b, 0n));

  const indices = Array.from({ length: n }, (_, i) => i);
  indices.sort((a, b) => {
    const diff = remainders[b] - remainders[a];
    if (diff > 0n) return 1;
    if (diff < 0n) return -1;
    return a - b; // tie-break : index croissant
  });

  const result = [...floors];
  for (let i = 0; i < leftover; i++) {
    result[indices[i]] += 1n;
  }
  return result;
}

export function allocateFees(
  lines: FeeAllocationLine[],
  fees: {
    freightTotal: number;
    customsTotal: number;
    transitTotal: number;
    localTransportTotal: number;
  },
): AllocatedLine[] {
  if (lines.length === 0) return [];

  const feeList = [
    BigInt(fees.freightTotal),
    BigInt(fees.customsTotal),
    BigInt(fees.transitTotal),
    BigInt(fees.localTransportTotal),
  ];

  // vᵢ = qtyᵢ × unitPurchasePriceᵢ
  const lineValuesBig = lines.map((l) => BigInt(l.qty) * BigInt(l.unitPurchasePrice));
  const totalValueBig = lineValuesBig.reduce((a, b) => a + b, 0n);

  const perLineAllocated: bigint[] = new Array(lines.length).fill(0n);

  for (const fee of feeList) {
    if (fee === 0n) continue;
    const dist = distributeByLargestRemainder(fee, lineValuesBig, totalValueBig);
    for (let i = 0; i < lines.length; i++) {
      perLineAllocated[i] += dist[i];
    }
  }

  return lines.map((line, i) => {
    const lineValue = Number(lineValuesBig[i]);
    const allocatedFees = Number(perLineAllocated[i]);
    const landedTotalValue = lineValue + allocatedFees;
    const landedUnitCost = line.qty > 0 ? Math.floor(landedTotalValue / line.qty) : 0;
    return { lineValue, allocatedFees, landedTotalValue, landedUnitCost };
  });
}

// Somme totale des frais d'un ensemble de lignes allouées — sert à la
// ligne de réconciliation affichée dans l'UI ("Σ alloués = Σ frais").
export function totalAllocatedFees(allocated: AllocatedLine[]): number {
  return allocated.reduce((sum, l) => sum + l.allocatedFees, 0);
}
