import { allocateFees, totalAllocatedFees } from '@/lib/purchases/fee-allocation';
import { describe, expect, it } from 'vitest';

const NO_FEES = { freightTotal: 0, customsTotal: 0, transitTotal: 0, localTransportTotal: 0 };

// ── helpers ──────────────────────────────────────────────────────────────────

function totalFees(fees: {
  freightTotal: number;
  customsTotal: number;
  transitTotal: number;
  localTransportTotal: number;
}): number {
  return fees.freightTotal + fees.customsTotal + fees.transitTotal + fees.localTransportTotal;
}

// ── cas de base ───────────────────────────────────────────────────────────────

describe('allocateFees — cas de base', () => {
  it('retourne [] pour un lot sans lignes', () => {
    const result = allocateFees([], {
      freightTotal: 5000,
      customsTotal: 0,
      transitTotal: 0,
      localTransportTotal: 0,
    });
    expect(result).toEqual([]);
  });

  it('retourne des frais nuls quand tous les frais sont 0', () => {
    const lines = [
      { qty: 5, unitPurchasePrice: 10000 },
      { qty: 3, unitPurchasePrice: 8000 },
    ];
    const result = allocateFees(lines, NO_FEES);
    for (const r of result) {
      expect(r.allocatedFees).toBe(0);
      expect(r.landedTotalValue).toBe(r.lineValue);
    }
  });

  it('ligne unique absorbe tous les frais', () => {
    const lines = [{ qty: 4, unitPurchasePrice: 5000 }];
    const fees = {
      freightTotal: 3000,
      customsTotal: 1200,
      transitTotal: 500,
      localTransportTotal: 300,
    };
    const [r] = allocateFees(lines, fees);
    expect(r.allocatedFees).toBe(totalFees(fees));
    expect(r.landedTotalValue).toBe(r.lineValue + totalFees(fees));
  });
});

// ── répartition divisible exactement ─────────────────────────────────────────

describe('allocateFees — montant divisible', () => {
  it('répartit proportionnellement sans reste (2 lignes valeur égale)', () => {
    const lines = [
      { qty: 2, unitPurchasePrice: 5000 }, // v = 10 000
      { qty: 2, unitPurchasePrice: 5000 }, // v = 10 000
    ];
    const fees = { freightTotal: 2000, customsTotal: 0, transitTotal: 0, localTransportTotal: 0 };
    const [r0, r1] = allocateFees(lines, fees);
    expect(r0.allocatedFees).toBe(1000);
    expect(r1.allocatedFees).toBe(1000);
    expect(r0.allocatedFees + r1.allocatedFees).toBe(2000);
  });

  it('répartit au prorata de la valeur (2 lignes valeur 2:1)', () => {
    // v0 = 2000, v1 = 1000, V = 3000, fret = 3000
    // → r0 = 2000, r1 = 1000
    const lines = [
      { qty: 2, unitPurchasePrice: 1000 }, // v = 2000
      { qty: 1, unitPurchasePrice: 1000 }, // v = 1000
    ];
    const fees = { freightTotal: 3000, customsTotal: 0, transitTotal: 0, localTransportTotal: 0 };
    const [r0, r1] = allocateFees(lines, fees);
    expect(r0.allocatedFees).toBe(2000);
    expect(r1.allocatedFees).toBe(1000);
  });
});

// ── plus grand reste (montant non divisible) ──────────────────────────────────

describe('allocateFees — plus grand reste', () => {
  it('fret 1 499, 3 lignes de valeur égale → somme exacte 1 499', () => {
    // v0=v1=v2=500, V=1500
    // floor_i = floor(1499*500/1500) = 499, reste_i = 1499*500 − 499*1500 = 1000 (égaux)
    // leftover = 1499 − 3×499 = 2 → lignes 0 et 1 (tie-break index asc)
    const lines = [
      { qty: 1, unitPurchasePrice: 500 },
      { qty: 1, unitPurchasePrice: 500 },
      { qty: 1, unitPurchasePrice: 500 },
    ];
    const fees = { freightTotal: 1499, customsTotal: 0, transitTotal: 0, localTransportTotal: 0 };
    const result = allocateFees(lines, fees);
    expect(result[0].allocatedFees).toBe(500);
    expect(result[1].allocatedFees).toBe(500);
    expect(result[2].allocatedFees).toBe(499);
    expect(totalAllocatedFees(result)).toBe(1499);
  });

  it('fret 1 499, valeurs 2:1 → le plus grand reste reçoit le franc restant', () => {
    // v0=1000, v1=500, V=1500
    // floor_0=floor(1499000/1500)=999, reste_0=1499*1000−999*1500=500
    // floor_1=floor(749500/1500)=499,  reste_1=1499*500−499*1500=1000
    // leftover=1 → ligne 1 (reste 1000 > 500)
    const lines = [
      { qty: 2, unitPurchasePrice: 500 }, // v = 1000
      { qty: 1, unitPurchasePrice: 500 }, // v = 500
    ];
    const fees = { freightTotal: 1499, customsTotal: 0, transitTotal: 0, localTransportTotal: 0 };
    const [r0, r1] = allocateFees(lines, fees);
    expect(r0.allocatedFees).toBe(999);
    expect(r1.allocatedFees).toBe(500);
    expect(r0.allocatedFees + r1.allocatedFees).toBe(1499);
  });

  it('invariant somme — 5 lignes, 4 frais non divisibles', () => {
    const lines = [
      { qty: 3, unitPurchasePrice: 7000 },
      { qty: 1, unitPurchasePrice: 12000 },
      { qty: 5, unitPurchasePrice: 4500 },
      { qty: 2, unitPurchasePrice: 9300 },
      { qty: 4, unitPurchasePrice: 6100 },
    ];
    const fees = {
      freightTotal: 17777,
      customsTotal: 8321,
      transitTotal: 4003,
      localTransportTotal: 2999,
    };
    const result = allocateFees(lines, fees);
    expect(totalAllocatedFees(result)).toBe(totalFees(fees));
  });
});

// ── cas limites ────────────────────────────────────────────────────────────────

describe('allocateFees — cas limites', () => {
  it('V = 0 (toutes les valeurs nulles) → répartition égale, somme exacte', () => {
    // qty=0 partout → v_i=0 → V=0 → fallback égal
    const lines = [
      { qty: 0, unitPurchasePrice: 5000 },
      { qty: 0, unitPurchasePrice: 5000 },
      { qty: 0, unitPurchasePrice: 5000 },
    ];
    const fees = { freightTotal: 100, customsTotal: 0, transitTotal: 0, localTransportTotal: 0 };
    const result = allocateFees(lines, fees);
    const sum = totalAllocatedFees(result);
    expect(sum).toBe(100);
  });

  it('ligne qty=0 dans un lot mixte → elle reçoit 0 francs de frais', () => {
    // La ligne qty=0 a v_i=0, donc aucun poids dans la répartition par valeur.
    const lines = [
      { qty: 0, unitPurchasePrice: 8000 }, // v = 0
      { qty: 5, unitPurchasePrice: 4000 }, // v = 20 000
    ];
    const fees = { freightTotal: 5000, customsTotal: 0, transitTotal: 0, localTransportTotal: 0 };
    const [r0, r1] = allocateFees(lines, fees);
    expect(r0.allocatedFees).toBe(0);
    expect(r1.allocatedFees).toBe(5000);
  });

  it('ligne qty=0 → landedUnitCost = 0 (pas de division par zéro)', () => {
    const lines = [{ qty: 0, unitPurchasePrice: 5000 }];
    const [r] = allocateFees(lines, NO_FEES);
    expect(r.landedUnitCost).toBe(0);
  });

  it('coût unitaire atterri = floor(landedTotalValue / qty)', () => {
    // 3 unités, landedTotalValue = 28 000 → 9 333 (floor de 9333.33)
    const lines = [{ qty: 3, unitPurchasePrice: 9000 }]; // lineValue = 27 000
    const fees = { freightTotal: 1000, customsTotal: 0, transitTotal: 0, localTransportTotal: 0 };
    const [r] = allocateFees(lines, fees);
    expect(r.landedTotalValue).toBe(28000);
    expect(r.landedUnitCost).toBe(Math.floor(28000 / 3)); // 9333
  });

  it('landedTotalValue = lineValue + allocatedFees (invariant)', () => {
    const lines = [
      { qty: 10, unitPurchasePrice: 3000 },
      { qty: 7, unitPurchasePrice: 5000 },
    ];
    const fees = {
      freightTotal: 12345,
      customsTotal: 6789,
      transitTotal: 1001,
      localTransportTotal: 555,
    };
    const result = allocateFees(lines, fees);
    for (const r of result) {
      expect(r.landedTotalValue).toBe(r.lineValue + r.allocatedFees);
    }
  });
});

// ── plusieurs frais combinés ───────────────────────────────────────────────────

describe('allocateFees — 4 frais combinés', () => {
  it('chaque frais est distribué indépendamment puis sommé par ligne', () => {
    const lines = [
      { qty: 2, unitPurchasePrice: 6000 }, // v = 12 000
      { qty: 3, unitPurchasePrice: 4000 }, // v = 12 000
    ];
    // Valeurs égales → chaque frais réparti 50/50 exactement
    const fees = {
      freightTotal: 2000,
      customsTotal: 1000,
      transitTotal: 600,
      localTransportTotal: 400,
    };
    const [r0, r1] = allocateFees(lines, fees);
    expect(r0.allocatedFees).toBe(2000); // (2000+1000+600+400)/2
    expect(r1.allocatedFees).toBe(2000);
    expect(totalAllocatedFees([r0, r1])).toBe(totalFees(fees));
  });
});
