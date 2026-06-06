import {
  type FeeSettings,
  computeCA,
  computeCOGS,
  computeExpensesByCategory,
  computeFinanceReport,
  computeMobileMoneyFees,
  computeReturnContraRevenue,
  computeReturnedCogsReversal,
} from '@/lib/finance/profit';
import { describe, expect, it } from 'vitest';

const settings: FeeSettings = {
  waveFee: 100,
  orangeMoneyFee: 100,
  freeMoneyFee: 100,
  transferTaxBps: 50,
  transferTaxCapMinor: 2_000,
};

describe('computeCA', () => {
  it('somme les totalAmount des commandes encaissées', () => {
    expect(computeCA([{ totalAmount: 10_000 }, { totalAmount: 20_000 }])).toBe(30_000);
  });

  it('retourne 0 si aucune commande', () => {
    expect(computeCA([])).toBe(0);
  });
});

describe('computeReturnContraRevenue', () => {
  it('somme les montants des retours', () => {
    expect(computeReturnContraRevenue([{ totalAmount: 15_000 }, { totalAmount: 5_000 }])).toBe(
      20_000,
    );
  });
});

describe('computeCOGS', () => {
  it('calcule unit_cost × qty pour chaque mouvement sold', () => {
    expect(
      computeCOGS([
        { orderId: 'o1', productId: 'p1', qty: 2, unitCost: 5_000 },
        { orderId: 'o2', productId: 'p1', qty: 1, unitCost: 6_000 },
      ]),
    ).toBe(16_000);
  });

  it('retourne 0 si aucun mouvement', () => {
    expect(computeCOGS([])).toBe(0);
  });
});

describe('computeReturnedCogsReversal', () => {
  it("annule le COGS au coût figé d'origine (retour restocké)", () => {
    const soldMap = new Map([['o1:p1', 5_000]]);
    expect(computeReturnedCogsReversal([{ orderId: 'o1', productId: 'p1', qty: 1 }], soldMap)).toBe(
      5_000,
    );
  });

  it("0 si le produit n'a pas de mouvement sold correspondant", () => {
    expect(
      computeReturnedCogsReversal([{ orderId: 'o1', productId: 'p1', qty: 1 }], new Map()),
    ).toBe(0);
  });

  it("n'annule rien si aucun courier_return (retour non restocké)", () => {
    const soldMap = new Map([['o1:p1', 5_000]]);
    expect(computeReturnedCogsReversal([], soldMap)).toBe(0);
  });
});

describe('computeMobileMoneyFees', () => {
  it('frais Wave = 1% + 0,5% (cap 2000)', () => {
    // 10 000 → providerFee=100 + transferTax=50 = 150
    expect(
      computeMobileMoneyFees([{ totalAmount: 10_000, paymentChannelAtDelivery: 'WAVE' }], settings),
    ).toBe(150);
  });

  it('plafonne la TTA à 2 000 F pour les gros montants', () => {
    // 1 000 000 → providerFee=10 000 + transferTax=min(5 000,2 000)=2 000 = 12 000
    expect(
      computeMobileMoneyFees(
        [{ totalAmount: 1_000_000, paymentChannelAtDelivery: 'WAVE' }],
        settings,
      ),
    ).toBe(12_000);
  });

  it('zéro frais pour les espèces', () => {
    expect(
      computeMobileMoneyFees(
        [{ totalAmount: 50_000, paymentChannelAtDelivery: 'ESPECES' }],
        settings,
      ),
    ).toBe(0);
  });

  it('zéro frais si canal null (traité comme espèces)', () => {
    expect(
      computeMobileMoneyFees([{ totalAmount: 50_000, paymentChannelAtDelivery: null }], settings),
    ).toBe(0);
  });

  it("arrondit à l'entier supérieur ou inférieur selon la règle standard", () => {
    // 333 FCFA × 100 bps → 3,33 → arrondi 3
    expect(
      computeMobileMoneyFees([{ totalAmount: 333, paymentChannelAtDelivery: 'WAVE' }], settings),
    ).toBe(3 + Math.min(Math.round((333 * 50 + 5_000) / 10_000), 2_000));
  });
});

describe('computeExpensesByCategory', () => {
  it('regroupe les dépenses par code et trie alphabétiquement', () => {
    const result = computeExpensesByCategory([
      { categoryCode: 'ADS', categoryLabel: 'Publicité', amountMinor: 5_000 },
      { categoryCode: 'RENT', categoryLabel: 'Loyer', amountMinor: 30_000 },
      { categoryCode: 'ADS', categoryLabel: 'Publicité', amountMinor: 3_000 },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ code: 'ADS', label: 'Publicité', totalMinor: 8_000 });
    expect(result[1]).toEqual({ code: 'RENT', label: 'Loyer', totalMinor: 30_000 });
  });
});

describe('computeFinanceReport — cas intégré', () => {
  const productInfoMap = new Map([['p1', { title: 'Sac cuir', currentUnitCostMinor: 5_200 }]]);

  it('calcule le P&L complet sans retour', () => {
    const report = computeFinanceReport({
      collectedOrders: [
        { id: 'o1', totalAmount: 20_000, paymentChannelAtDelivery: 'ESPECES' },
        { id: 'o2', totalAmount: 10_000, paymentChannelAtDelivery: 'WAVE' },
      ],
      soldMovementsForCollected: [
        { orderId: 'o1', productId: 'p1', qty: 2, unitCost: 5_000 },
        { orderId: 'o2', productId: 'p1', qty: 1, unitCost: 5_000 },
      ],
      returnedOrders: [],
      courierReturns: [],
      soldMovementsForReturned: [],
      expenses: [{ categoryCode: 'ADS', categoryLabel: 'Publicité', amountMinor: 2_000 }],
      settings,
      productInfo: productInfoMap,
    });

    expect(report.caMinor).toBe(30_000);
    expect(report.returnContraRevenueMinor).toBe(0);
    expect(report.netCAMinor).toBe(30_000);
    // COGS = 2×5000 + 1×5000 = 15 000
    expect(report.cogsMinor).toBe(15_000);
    expect(report.returnedCogsReversalMinor).toBe(0);
    expect(report.netCogsMinor).toBe(15_000);
    // grossMargin = 30 000 - 15 000 = 15 000
    expect(report.grossMarginMinor).toBe(15_000);
    expect(report.grossMarginBps).toBe(5_000); // 50%
    // Wave fee: 10 000 × 100bps = 100 + min(50,2000)=50 → 150
    expect(report.mobileMoneyFeesMinor).toBe(150);
    expect(report.expensesMinor).toBe(2_000);
    // net = 15 000 - 2 000 - 150 = 12 850
    expect(report.netProfitMinor).toBe(12_850);
  });

  it('retour restocké — CA réduit, COGS annulé au coût figé', () => {
    // Commande encaissée en M-1, retournée en M (différentes périodes)
    const report = computeFinanceReport({
      collectedOrders: [],
      soldMovementsForCollected: [],
      returnedOrders: [{ id: 'o1', totalAmount: 20_000 }],
      courierReturns: [{ orderId: 'o1', productId: 'p1', qty: 2 }],
      soldMovementsForReturned: [{ orderId: 'o1', productId: 'p1', qty: 2, unitCost: 5_000 }],
      expenses: [],
      settings,
      productInfo: productInfoMap,
    });

    expect(report.caMinor).toBe(0);
    expect(report.returnContraRevenueMinor).toBe(20_000);
    expect(report.netCAMinor).toBe(-20_000);
    // COGS du mois = 0 (rien vendu ce mois)
    expect(report.cogsMinor).toBe(0);
    // Reversal = 2 × 5 000 = 10 000
    expect(report.returnedCogsReversalMinor).toBe(10_000);
    // netCOGS = 0 - 10 000 = -10 000 (COGS négatif = crédit)
    expect(report.netCogsMinor).toBe(-10_000);
    // grossMargin = -20 000 - (-10 000) = -10 000
    expect(report.grossMarginMinor).toBe(-10_000);
  });

  it('retour non restocké — CA réduit, COGS non annulé', () => {
    const report = computeFinanceReport({
      collectedOrders: [],
      soldMovementsForCollected: [],
      returnedOrders: [{ id: 'o1', totalAmount: 20_000 }],
      courierReturns: [], // pas de courier_return → non restocké
      soldMovementsForReturned: [{ orderId: 'o1', productId: 'p1', qty: 2, unitCost: 5_000 }],
      expenses: [],
      settings,
      productInfo: productInfoMap,
    });

    expect(report.returnContraRevenueMinor).toBe(20_000);
    expect(report.returnedCogsReversalMinor).toBe(0); // pas de reversal
    expect(report.netCogsMinor).toBe(0);
    expect(report.grossMarginMinor).toBe(-20_000); // seul CA réduit
  });

  it('même mois : commande encaissée ET retournée → CA net zéro', () => {
    const report = computeFinanceReport({
      collectedOrders: [{ id: 'o1', totalAmount: 20_000, paymentChannelAtDelivery: 'ESPECES' }],
      soldMovementsForCollected: [{ orderId: 'o1', productId: 'p1', qty: 2, unitCost: 5_000 }],
      returnedOrders: [{ id: 'o1', totalAmount: 20_000 }],
      courierReturns: [{ orderId: 'o1', productId: 'p1', qty: 2 }],
      soldMovementsForReturned: [], // déjà dans soldMovementsForCollected
      expenses: [],
      settings,
      productInfo: productInfoMap,
    });

    expect(report.netCAMinor).toBe(0);
    // COGS = 10 000, reversal = 10 000 → net 0
    expect(report.netCogsMinor).toBe(0);
    expect(report.grossMarginMinor).toBe(0);
  });
});

describe('computeFinanceReport — qualité du COGS (fix marge 100 %)', () => {
  const productInfo = new Map([['p1', { title: 'Sac cuir', currentUnitCostMinor: 4_000 }]]);

  it('coût figé ≠ 0 → utilisé tel quel, marge réelle (pas estimée)', () => {
    const report = computeFinanceReport({
      collectedOrders: [{ id: 'o1', totalAmount: 20_000, paymentChannelAtDelivery: 'ESPECES' }],
      soldMovementsForCollected: [{ orderId: 'o1', productId: 'p1', qty: 2, unitCost: 5_000 }],
      returnedOrders: [],
      courierReturns: [],
      soldMovementsForReturned: [],
      expenses: [],
      settings,
      productInfo,
    });

    // coût figé 5 000 prioritaire (≠ CUMP courant 4 000)
    expect(report.cogsMinor).toBe(10_000);
    expect(report.cogsEstimated).toBe(false);
    expect(report.cogsEstimatedMinor).toBe(0);
    expect(report.cogsCostedOrderCount).toBe(1);
    expect(report.cogsExcludedOrderCount).toBe(0);
    expect(report.grossMarginBps).toBe(5_000); // 50 %, ≠ 100 %
  });

  it('coût figé = 0 mais produit a un CUMP → fallback estimé, marge < 100 %', () => {
    const report = computeFinanceReport({
      collectedOrders: [{ id: 'o1', totalAmount: 20_000, paymentChannelAtDelivery: 'ESPECES' }],
      soldMovementsForCollected: [{ orderId: 'o1', productId: 'p1', qty: 2, unitCost: 0 }],
      returnedOrders: [],
      courierReturns: [],
      soldMovementsForReturned: [],
      expenses: [],
      settings,
      productInfo,
    });

    // fallback sur CUMP courant 4 000 → COGS 8 000 (aurait été 0 → marge 100 % avant le fix)
    expect(report.cogsMinor).toBe(8_000);
    expect(report.cogsEstimated).toBe(true);
    expect(report.cogsEstimatedMinor).toBe(8_000);
    expect(report.cogsExcludedOrderCount).toBe(0);
    expect(report.grossMarginMinor).toBe(12_000);
    expect(report.grossMarginBps).toBeLessThan(10_000); // pas 100 %
    expect(report.productBreakdown[0].estimated).toBe(true);
  });

  it('commande sans ligne sold → exclue du COGS, signalée (pas 0 silencieux)', () => {
    const report = computeFinanceReport({
      collectedOrders: [
        { id: 'o1', totalAmount: 20_000, paymentChannelAtDelivery: 'ESPECES' },
        { id: 'o2', totalAmount: 30_000, paymentChannelAtDelivery: 'ESPECES' },
      ],
      // seule o1 a une ligne ; o2 (sans order_line) n'a aucun mouvement sold
      soldMovementsForCollected: [{ orderId: 'o1', productId: 'p1', qty: 1, unitCost: 5_000 }],
      returnedOrders: [],
      courierReturns: [],
      soldMovementsForReturned: [],
      expenses: [],
      settings,
      productInfo,
    });

    expect(report.cogsCostedOrderCount).toBe(1);
    expect(report.cogsExcludedOrderCount).toBe(1); // o2 signalée, pas comptée comme COGS 0
    expect(report.cogsMinor).toBe(5_000); // uniquement o1
  });

  it('coût figé 0 ET CUMP 0 (inconnu) → ligne exclue du COGS et signalée, pas 0 silencieux', () => {
    // p2 sans CUMP courant (jamais acheté) ; o2 n'a que cette ligne au coût inconnu.
    const productInfoWithBlind = new Map([
      ['p1', { title: 'Sac cuir', currentUnitCostMinor: 4_000 }],
      ['p2', { title: 'Ceinture', currentUnitCostMinor: 0 }],
    ]);
    const report = computeFinanceReport({
      collectedOrders: [
        { id: 'o1', totalAmount: 20_000, paymentChannelAtDelivery: 'ESPECES' },
        { id: 'o2', totalAmount: 8_000, paymentChannelAtDelivery: 'ESPECES' },
      ],
      soldMovementsForCollected: [
        { orderId: 'o1', productId: 'p1', qty: 1, unitCost: 5_000 }, // coût figé réel
        { orderId: 'o2', productId: 'p2', qty: 1, unitCost: 0 }, // figé 0 ET CUMP 0 → inconnu
      ],
      returnedOrders: [],
      courierReturns: [],
      soldMovementsForReturned: [],
      expenses: [],
      settings,
      productInfo: productInfoWithBlind,
    });

    expect(report.cogsUnknownLineCount).toBe(1); // la ligne p2 signalée
    expect(report.cogsMinor).toBe(5_000); // o2/p2 exclue, PAS comptée 0 dans un COGS « réel »
    expect(report.cogsEstimated).toBe(false); // aucune estimation (CUMP indispo)
    expect(report.cogsCostedOrderCount).toBe(1); // seule o1 a un coût connu
    expect(report.cogsExcludedOrderCount).toBe(1); // o2 traitée comme une commande sans ligne
    // Le CA de o2 reste compté (on n'exclut que sa ligne COGS inconnue, pas son revenu) :
    // marge brute = CA net (28 000) − COGS connu (5 000) = 23 000. o2 est signalée comme exclue/inconnue.
    expect(report.netCAMinor).toBe(28_000);
    expect(report.grossMarginMinor).toBe(28_000 - 5_000);
  });
});
