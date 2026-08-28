import {
  type LotProductLine,
  allocateTransportCost,
  computeCostOfSold,
  computeLandedCost,
  computeLotProductProfitability,
  computeMargin,
  isAllocationMethodAvailable,
} from '@/lib/finance/lot-profitability';
import { describe, expect, it } from 'vitest';

function line(overrides: Partial<LotProductLine> & { productId: string }): LotProductLine {
  return {
    qtyReceived: 0,
    qtySold: 0,
    purchaseValueMinor: 0,
    weightGrams: null,
    ...overrides,
  };
}

describe('lot-profitability — contrôle de référence (arrivage du 27 avril)', () => {
  // Preuve 1 : 20 reçus, coût de revient 265 200 F, 19 vendus → revient des
  // vendus 251 940 F, CA encaissé 408 000 F, publicité 66 700 F,
  // marge 89 360 F, soit 21,9 %. Le split achat/transport n'affecte pas le
  // total pour un arrivage mono-produit (100 % du transport lui revient).
  it('reproduit exactement les chiffres du marchand', () => {
    const single = line({
      productId: 'p1',
      qtyReceived: 20,
      qtySold: 19,
      purchaseValueMinor: 265_200,
      weightGrams: 5_000,
    });

    const result = computeLotProductProfitability({
      line: single,
      allLinesInLot: [single],
      allocationMethod: 'value',
      transportTotalMinor: 0,
      transportComplete: true,
      cashCollectedMinor: 408_000,
      adSpend: { valueMinor: 66_700, complete: true },
    });

    expect(result.landedTotalMinor).toBe(265_200);
    expect(result.costOfSoldMinor).toBe(251_940);
    expect(result.marginMinor).toBe(89_360);
    expect(result.marginPct).toBeCloseTo(0.219, 3);
    expect(result.complete).toBe(true);
    expect(result.missingInputs).toEqual([]);
  });

  it('produit le même résultat quel que soit le split achat/transport, tant que la somme est 265 200', () => {
    const splitA = line({
      productId: 'p1',
      qtyReceived: 20,
      qtySold: 19,
      purchaseValueMinor: 240_000,
    });

    const resultA = computeLotProductProfitability({
      line: splitA,
      allLinesInLot: [splitA],
      allocationMethod: 'value',
      transportTotalMinor: 25_200,
      transportComplete: true,
      cashCollectedMinor: 408_000,
      adSpend: { valueMinor: 66_700, complete: true },
    });

    expect(resultA.landedTotalMinor).toBe(265_200);
    expect(resultA.costOfSoldMinor).toBe(251_940);
    expect(resultA.marginMinor).toBe(89_360);
  });
});

describe('lot-profitability — les trois méthodes de répartition (preuve 2)', () => {
  const multi: LotProductLine[] = [
    line({
      productId: 'a',
      qtyReceived: 10,
      qtySold: 8,
      purchaseValueMinor: 100_000,
      weightGrams: 3_000,
    }),
    line({
      productId: 'b',
      qtyReceived: 30,
      qtySold: 20,
      purchaseValueMinor: 50_000,
      weightGrams: 1_000,
    }),
    line({
      productId: 'c',
      qtyReceived: 5,
      qtySold: 5,
      purchaseValueMinor: 150_000,
      weightGrams: 6_000,
    }),
  ];
  const transportTotal = 77_777; // pas un multiple net des bases de répartition

  it.each<['value' | 'quantity' | 'weight']>([['value'], ['quantity'], ['weight']])(
    'méthode %s : la somme des parts allouées égale exactement le transport total',
    (method) => {
      const allocations = allocateTransportCost(multi, method, transportTotal);
      const sum = allocations.reduce((acc, a) => acc + a.allocatedTransportMinor, 0);
      expect(sum).toBe(transportTotal);
      expect(allocations).toHaveLength(3);
      for (const a of allocations) {
        expect(a.allocatedTransportMinor).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it('méthode "quantity" : proportionnelle aux quantités reçues (10/30/5 → poids 10:30:5)', () => {
    const allocations = allocateTransportCost(multi, 'quantity', 45_000);
    const byId = Object.fromEntries(
      allocations.map((a) => [a.productId, a.allocatedTransportMinor]),
    );
    // 45 unités reçues au total, 45000/45 = 1000 par unité exactement → pas d'arrondi à vérifier ici.
    expect(byId.a).toBe(10_000);
    expect(byId.b).toBe(30_000);
    expect(byId.c).toBe(5_000);
  });

  it('méthode "value" : proportionnelle à la valeur d\'achat (100k/50k/150k, total 300k)', () => {
    const allocations = allocateTransportCost(multi, 'value', 300_000);
    const byId = Object.fromEntries(
      allocations.map((a) => [a.productId, a.allocatedTransportMinor]),
    );
    expect(byId.a).toBe(100_000);
    expect(byId.b).toBe(50_000);
    expect(byId.c).toBe(150_000);
  });

  it('méthode "weight" : proportionnelle au poids (3000/1000/6000, total 10000g)', () => {
    const allocations = allocateTransportCost(multi, 'weight', 100_000);
    const byId = Object.fromEntries(
      allocations.map((a) => [a.productId, a.allocatedTransportMinor]),
    );
    expect(byId.a).toBe(30_000);
    expect(byId.b).toBe(10_000);
    expect(byId.c).toBe(60_000);
  });
});

describe('lot-profitability — changement de méthode après saisie (preuve 3)', () => {
  it('deux appels successifs avec des méthodes différentes ne partagent aucun état', () => {
    const multi: LotProductLine[] = [
      line({ productId: 'a', qtyReceived: 7, purchaseValueMinor: 33_333, weightGrams: 500 }),
      line({ productId: 'b', qtyReceived: 13, purchaseValueMinor: 66_667, weightGrams: 1_500 }),
    ];

    const byValue = allocateTransportCost(multi, 'value', 10_007);
    const byQuantity = allocateTransportCost(multi, 'quantity', 10_007);
    const byValueAgain = allocateTransportCost(multi, 'value', 10_007);

    // Rejouer 'value' donne EXACTEMENT le même résultat que la première fois
    // (fonction pure, aucun état stocké entre les appels) — mais un résultat
    // différent de 'quantity' sur ces mêmes lignes.
    expect(byValueAgain).toEqual(byValue);
    expect(byQuantity).not.toEqual(byValue);

    // Les deux méthodes restent exactes malgré un total non multiple des bases.
    expect(byValue.reduce((s, a) => s + a.allocatedTransportMinor, 0)).toBe(10_007);
    expect(byQuantity.reduce((s, a) => s + a.allocatedTransportMinor, 0)).toBe(10_007);
  });
});

describe('lot-profitability — méthode indisponible sans poids (preuve 4)', () => {
  it("isAllocationMethodAvailable refuse 'weight' si une seule ligne manque de poids", () => {
    const lines = [
      line({ productId: 'a', weightGrams: 100 }),
      line({ productId: 'b', weightGrams: null }),
    ];

    expect(isAllocationMethodAvailable(lines, 'weight')).toEqual({
      available: false,
      reason: 'missing_weight',
    });
    expect(isAllocationMethodAvailable(lines, 'value')).toEqual({ available: true });
    expect(isAllocationMethodAvailable(lines, 'quantity')).toEqual({ available: true });
  });

  it('allocateTransportCost lève explicitement si on force "weight" sans poids complet', () => {
    const lines = [
      line({ productId: 'a', weightGrams: 100 }),
      line({ productId: 'b', weightGrams: null }),
    ];

    expect(() => allocateTransportCost(lines, 'weight', 1_000)).toThrow(
      /allocation_method_unavailable:missing_weight/,
    );
  });

  it('disponible dès que toutes les lignes portent un poids', () => {
    const lines = [
      line({ productId: 'a', weightGrams: 100 }),
      line({ productId: 'b', weightGrams: 200 }),
    ];
    expect(isAllocationMethodAvailable(lines, 'weight')).toEqual({ available: true });
    expect(() => allocateTransportCost(lines, 'weight', 300)).not.toThrow();
  });
});

describe('lot-profitability — marge provisoire (preuve 5, propagation de complétude)', () => {
  it('marge complète quand transport ET publicité sont connus', () => {
    const result = computeMargin({
      cashCollectedMinor: 100_000,
      costOfSoldMinor: 40_000,
      transportComplete: true,
      adSpend: { valueMinor: 10_000, complete: true },
    });
    expect(result.complete).toBe(true);
    expect(result.missingInputs).toEqual([]);
    expect(result.marginMinor).toBe(50_000);
  });

  it('transport pas encore connu → provisoire, nomme "transport_total", montant quand même calculé', () => {
    const result = computeMargin({
      cashCollectedMinor: 100_000,
      costOfSoldMinor: 40_000,
      transportComplete: false,
      adSpend: { valueMinor: 10_000, complete: true },
    });
    expect(result.complete).toBe(false);
    expect(result.missingInputs).toEqual(['transport_total']);
    // Le montant reste calculé sur les coûts connus — jamais null/absent.
    expect(result.marginMinor).toBe(50_000);
  });

  it('publicité pas encore saisie → provisoire, nomme "ad_spend"', () => {
    const result = computeMargin({
      cashCollectedMinor: 100_000,
      costOfSoldMinor: 40_000,
      transportComplete: true,
      adSpend: { valueMinor: 0, complete: false },
    });
    expect(result.complete).toBe(false);
    expect(result.missingInputs).toEqual(['ad_spend']);
    expect(result.marginMinor).toBe(60_000);
  });

  it('les deux manquent → provisoire, nomme les deux, dans cet ordre', () => {
    const result = computeMargin({
      cashCollectedMinor: 100_000,
      costOfSoldMinor: 40_000,
      transportComplete: false,
      adSpend: { valueMinor: 0, complete: false },
    });
    expect(result.complete).toBe(false);
    expect(result.missingInputs).toEqual(['transport_total', 'ad_spend']);
  });

  // Mutation-test manuel : si la propagation de complétude était cassée (ex.
  // `complete` codé en dur à `true`, ou `missingInputs` toujours vide), CES
  // assertions précises échoueraient — un montant provisoire ne doit JAMAIS
  // passer pour complet.
  it('un montant provisoire ne se fait jamais passer pour complet (mutation-test)', () => {
    const provisional = computeMargin({
      cashCollectedMinor: 100_000,
      costOfSoldMinor: 40_000,
      transportComplete: false,
      adSpend: { valueMinor: 10_000, complete: true },
    });
    const complete = computeMargin({
      cashCollectedMinor: 100_000,
      costOfSoldMinor: 40_000,
      transportComplete: true,
      adSpend: { valueMinor: 10_000, complete: true },
    });

    // Même marge chiffrée (le calcul ne dépend QUE des coûts connus), mais
    // les drapeaux de complétude divergent strictement.
    expect(provisional.marginMinor).toBe(complete.marginMinor);
    expect(provisional.complete).not.toBe(complete.complete);
    expect(provisional.complete).toBe(false);
    expect(complete.complete).toBe(true);
    expect(provisional.missingInputs.length).toBeGreaterThan(0);
    expect(complete.missingInputs.length).toBe(0);
  });

  it("computeLotProductProfitability propage la complétude jusqu'au résultat final", () => {
    const single = line({
      productId: 'p1',
      qtyReceived: 10,
      qtySold: 10,
      purchaseValueMinor: 100_000,
    });

    const result = computeLotProductProfitability({
      line: single,
      allLinesInLot: [single],
      allocationMethod: 'value',
      transportTotalMinor: 5_000,
      transportComplete: false,
      cashCollectedMinor: 200_000,
      adSpend: { valueMinor: 0, complete: false },
    });

    expect(result.complete).toBe(false);
    expect(result.missingInputs).toEqual(['transport_total', 'ad_spend']);
    // Le montant reste un nombre exploitable, jamais null.
    expect(typeof result.marginMinor).toBe('number');
  });
});

describe('lot-profitability — arrondis déterministes (preuve 6)', () => {
  it('nombre premier réparti sur 3 parts égales : la somme égale le total, reste attribué à index 0', () => {
    const lines = [
      line({ productId: 'a', qtyReceived: 1 }),
      line({ productId: 'b', qtyReceived: 1 }),
      line({ productId: 'c', qtyReceived: 1 }),
    ];
    // 100003 est premier ; 100003 / 3 = 33334.33...
    const allocations = allocateTransportCost(lines, 'quantity', 100_003);
    const sum = allocations.reduce((s, a) => s + a.allocatedTransportMinor, 0);
    expect(sum).toBe(100_003);

    const byId = Object.fromEntries(
      allocations.map((a) => [a.productId, a.allocatedTransportMinor]),
    );
    expect(byId.a).toBe(33_335);
    expect(byId.b).toBe(33_334);
    expect(byId.c).toBe(33_334);
  });

  it('265 200 F réparti sur trois produits ne produit jamais 265 199 ou 265 201', () => {
    const lines = [
      line({ productId: 'a', qtyReceived: 7, purchaseValueMinor: 11_111 }),
      line({ productId: 'b', qtyReceived: 13, purchaseValueMinor: 22_222 }),
      line({ productId: 'c', qtyReceived: 17, purchaseValueMinor: 33_333 }),
    ];
    for (const method of ['value', 'quantity'] as const) {
      const allocations = allocateTransportCost(lines, method, 265_200);
      const sum = allocations.reduce((s, a) => s + a.allocatedTransportMinor, 0);
      expect(sum).toBe(265_200);
    }
  });

  it('restes non nuls sur des poids premiers distincts', () => {
    const lines = [
      line({ productId: 'a', weightGrams: 997 }),
      line({ productId: 'b', weightGrams: 991 }),
      line({ productId: 'c', weightGrams: 983 }),
    ];
    const allocations = allocateTransportCost(lines, 'weight', 123_457);
    const sum = allocations.reduce((s, a) => s + a.allocatedTransportMinor, 0);
    expect(sum).toBe(123_457);
    for (const a of allocations) {
      expect(Number.isInteger(a.allocatedTransportMinor)).toBe(true);
    }
  });

  it('base de répartition totalement nulle (ex. toutes les valeurs à 0) reste répartie et exacte', () => {
    const lines = [
      line({ productId: 'a', purchaseValueMinor: 0 }),
      line({ productId: 'b', purchaseValueMinor: 0 }),
      line({ productId: 'c', purchaseValueMinor: 0 }),
    ];
    const allocations = allocateTransportCost(lines, 'value', 10);
    const sum = allocations.reduce((s, a) => s + a.allocatedTransportMinor, 0);
    expect(sum).toBe(10);
  });

  it('computeCostOfSold et computeLandedCost restent des entiers pour des ratios non exacts', () => {
    const landed = computeLandedCost(
      line({ productId: 'p', qtyReceived: 7, purchaseValueMinor: 100_000 }),
      3_333,
    );
    expect(Number.isInteger(landed.landedUnitCostMinor)).toBe(true);
    expect(Number.isInteger(landed.landedTotalMinor)).toBe(true);

    const costOfSold = computeCostOfSold(landed.landedTotalMinor, 7, 5);
    expect(Number.isInteger(costOfSold)).toBe(true);
    expect(costOfSold).toBeLessThanOrEqual(landed.landedTotalMinor);
  });
});

describe('lot-profitability — invendu', () => {
  it('unsoldCostEngagedMinor porte le coût déjà engagé des unités restantes', () => {
    const single = line({
      productId: 'p1',
      qtyReceived: 20,
      qtySold: 19,
      purchaseValueMinor: 265_200,
    });

    const result = computeLotProductProfitability({
      line: single,
      allLinesInLot: [single],
      allocationMethod: 'value',
      transportTotalMinor: 0,
      transportComplete: true,
      cashCollectedMinor: 408_000,
      adSpend: { valueMinor: 66_700, complete: true },
    });

    expect(result.unsoldUnits).toBe(1);
    // landedUnitCostMinor = floor(265200 / 20) = 13260
    expect(result.unsoldCostEngagedMinor).toBe(13_260);
  });
});
