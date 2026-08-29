// @vitest-environment jsdom

/**
 * Phase F — Lot F2, correctif revue (Critique 1) : la branche `ok:true &&
 * allocationMethodAvailable:true` de `PurchaseLotDetailPanel` (carte de marge,
 * les 4 métriques scopées, invendu, avancement, `ListCard` par produit) n'avait
 * JAMAIS été rendue — ni en local (RPC `get_purchase_lot_profitability` 404 tant
 * que la migration 0146 n'est pas poussée), ni en test automatisé. Ce fichier
 * construit une fixture `PurchaseLotProfitabilitySummary` à la main (le type est
 * exporté par lib/finance/lot-profitability-assembly.ts — aucun accès base
 * requis) et prouve que la branche se rend sans planter, avec le bon contenu.
 *
 * Deuxième test (Important 1) : preuve que deux comportements de complétude
 * distincts sont démontrables SIMULTANÉMENT sur le même écran —
 *  (a) une valeur dérivée dont l'entrée amont manque totalement reste MASQUÉE
 *      (`ValueAmount`/`kind:'missing'`) : la marge % quand `cashCollectedMinor
 *      === 0` (rien à mesurer, pas « 0 % ») ;
 *  (b) une marge calculée sur des coûts connus mais incomplets reste
 *      PROVISOIRE, en nommant ce qui manque (transport pas encore facturé).
 */

import { PurchaseLotDetailPanel } from '@/components/purchases/purchase-lot-detail-panel';
import type { PurchaseLotData } from '@/lib/actions/purchases';
import type { PurchaseLotProfitabilitySummary } from '@/lib/finance/lot-profitability-assembly';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// `@/lib/actions/purchases` est un fichier `'use server'` qui importe `env`
// (lib/env.ts, validé au chargement du module — cf. CLAUDE.md, « Importer
// n'importe quel export d'un fichier qui importe `env` force la validation »).
// Le rendu de ce composant n'a besoin d'aucune vraie Server Action ni d'accès
// base : on mock ce module au niveau des trois exports réellement utilisés,
// jamais exécutés dans ces deux tests (rendu statique uniquement, aucune
// interaction de mutation).
vi.mock('@/lib/actions/purchases', () => ({
  getPurchaseLotProfitability: vi.fn(async () => ({ ok: false, reason: 'error' })),
  setPurchaseLotAllocationMethodAction: vi.fn(),
  setPurchaseLotLineWeightAction: vi.fn(async () => ({ data: { ok: true } })),
}));

// `useAction` (next-safe-action/hooks) n'a besoin d'aucun vrai client d'action
// pour ces tests — seul son état initial (`isExecuting: false`) est lu par
// `MethodSelector` au rendu.
vi.mock('next-safe-action/hooks', () => ({
  useAction: () => ({
    execute: () => {},
    executeAsync: async () => ({ data: { ok: true } }),
    isExecuting: false,
    isIdle: true,
    isPending: false,
    isTransitioning: false,
    result: {},
    status: 'idle',
    reset: () => {},
  }),
}));

beforeAll(() => {
  // DetailPanel lit window.matchMedia via useIsDesktop — jsdom ne l'implémente
  // pas nativement (même stub que tests/unit/ui/explanation-card.test.tsx).
  window.matchMedia =
    window.matchMedia ??
    ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
});

afterEach(() => {
  cleanup();
});

const baseLot: PurchaseLotData = {
  id: 'lot-1',
  supplierName: 'Fournisseur Wax Import',
  reference: 'REF-2026-08',
  orderedAt: '2026-07-20',
  status: 'received',
  estimatedLeadTimeDays: 7,
  eta: '27 juillet 2026',
  transportTotal: 15_000,
  receivedAt: '2026-07-28',
  allocationMethod: 'value',
  lines: [
    {
      id: 'line-1',
      productId: 'prod-1',
      productTitle: 'Robe wax imprimée',
      productSku: 'SKU-001',
      qty: 20,
      purchasePriceTotal: 200_000,
      lineValue: 200_000,
      allocatedFees: 15_000,
      landedTotalValue: 215_000,
      landedUnitCost: 10_750,
      weightGrams: 5_000,
      preview: null,
    },
  ],
};

// Cas de succès complet : tous les coûts connus, du CA encaissé — la marge et
// ses 4 métriques scopées, l'invendu et l'avancement s'affichent sans aucun
// masquage/provisoire.
const successProfitability: PurchaseLotProfitabilitySummary = {
  ok: true,
  allocationMethodAvailable: true,
  allocationMethod: 'value',
  lines: [
    {
      productId: 'prod-1',
      purchaseLotLineId: 'line-1',
      allocatedTransportMinor: 15_000,
      landedTotalMinor: 215_000,
      landedUnitCostMinor: 10_750,
      costOfSoldMinor: 161_250,
      adSpendPerUnitMinor: 4_446,
      unsoldUnits: 5,
      unsoldCostEngagedMinor: 53_750,
      marginMinor: 89_360,
      marginPct: 0.219,
      complete: true,
      missingInputs: [],
    },
  ],
  totals: {
    cashCollectedMinor: 408_000,
    costOfSoldMinor: 161_250,
    adSpendMinor: 66_700,
    marginMinor: 179_050,
    marginPct: 0.4389,
    complete: true,
    missingInputs: [],
    unsoldUnits: 5,
    unsoldCostEngagedMinor: 53_750,
    qtyReceived: 20,
    qtySold: 15,
  },
};

// Cas provisoire ET masqué à la fois, sur le MÊME écran :
//  - transport pas encore facturé (`missingInputs` inclut 'transport_total') →
//    coût de revient des vendus affiché en `estimated` (provisoire, nommé) ;
//  - aucun CA encaissé (`cashCollectedMinor === 0`) → la marge % n'a rien à
//    mesurer, elle doit être MASQUÉE (`kind:'missing'`), jamais « 0,0 % ».
const provisionalAndMaskedProfitability: PurchaseLotProfitabilitySummary = {
  ok: true,
  allocationMethodAvailable: true,
  allocationMethod: 'value',
  lines: [
    {
      productId: 'prod-1',
      purchaseLotLineId: 'line-1',
      allocatedTransportMinor: 0,
      landedTotalMinor: 200_000,
      landedUnitCostMinor: 10_000,
      costOfSoldMinor: 0,
      adSpendPerUnitMinor: null,
      unsoldUnits: 20,
      unsoldCostEngagedMinor: 200_000,
      marginMinor: 0,
      marginPct: 0,
      complete: false,
      missingInputs: ['transport_total'],
    },
  ],
  totals: {
    cashCollectedMinor: 0,
    costOfSoldMinor: 0,
    adSpendMinor: 0,
    marginMinor: 0,
    marginPct: 0,
    complete: false,
    missingInputs: ['transport_total'],
    unsoldUnits: 20,
    unsoldCostEngagedMinor: 200_000,
    qtyReceived: 20,
    qtySold: 0,
  },
};

describe('PurchaseLotDetailPanel — branche succès (ok:true, allocationMethodAvailable:true)', () => {
  it('rend la marge, les 4 métriques scopées, invendu, avancement et une ListCard par produit', () => {
    render(
      <PurchaseLotDetailPanel
        lot={baseLot}
        profitability={successProfitability}
        open={true}
        onClose={() => {}}
      />,
    );

    // Figure de marge (GainLoss) — présente et positive.
    expect(screen.getByTestId('gain-loss')).toBeTruthy();
    expect(screen.getByText(/179 050 F CFA/)).toBeTruthy();

    // Les 4 métriques scopées de la grille — libellés exacts du composant.
    expect(screen.getByText('CA encaissé')).toBeTruthy();
    expect(screen.getByText('Coût de revient des vendus')).toBeTruthy();
    expect(screen.getByText('Dépenses publicitaires')).toBeTruthy();
    expect(screen.getByText('Marge %')).toBeTruthy();
    // Localisé fr-FR (virgule décimale) — correctif revue finale, pas
    // `toFixed(1)` (point anglais).
    expect(screen.getByText('43,9 %')).toBeTruthy();

    // Invendu et avancement des ventes.
    expect(screen.getByText('Invendu')).toBeTruthy();
    expect(screen.getByText('5 unités')).toBeTruthy();
    expect(screen.getByText('Avancement des ventes')).toBeTruthy();
    expect(screen.getByText('15 vendues / 5 restantes')).toBeTruthy();

    // ListCard par produit — titre + valeur principale toujours visibles ;
    // le détail (« Coût de revient rendu ») est replié par défaut (ListCard).
    // Le libellé du produit apparaît deux fois (ListCard + éditeur de poids
    // dans « Répartition par produit ») — on ne teste ici que sa présence.
    expect(screen.getAllByText('Robe wax imprimée').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /Détails/i }));
    expect(screen.getByText('Coût de revient rendu')).toBeTruthy();
    expect(screen.getByText('Coût publicitaire / vente')).toBeTruthy();

    // Rien de masqué/provisoire quand tout est connu.
    expect(screen.queryByTestId('value-state-missing')).toBeNull();
    expect(screen.queryByText(/Marge provisoire/)).toBeNull();
  });
});

describe('PurchaseLotDetailPanel — marge provisoire ET marge % masquée, sur le même écran', () => {
  it('masque la marge % (aucun CA encaissé) sans empêcher le coût provisoire de s’afficher', () => {
    render(
      <PurchaseLotDetailPanel
        lot={baseLot}
        profitability={provisionalAndMaskedProfitability}
        open={true}
        onClose={() => {}}
      />,
    );

    // (a) Valeur dérivée MASQUÉE : la marge % n'a rien à mesurer sans CA
    // encaissé — jamais rendue comme un chiffre confiant (« 0,0 % »).
    expect(screen.getByTestId('value-state-missing')).toBeTruthy();
    expect(screen.getByText('Pas encore de CA encaissé sur cet arrivage')).toBeTruthy();
    expect(screen.queryByText(/^0,0 %$/)).toBeNull();

    // (b) Marge PROVISOIRE nommant ce qui manque, sur un coût par ailleurs connu.
    expect(screen.getByText(/Marge provisoire — en attente de/)).toBeTruthy();
    expect(screen.getAllByTestId('value-state-estimated').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Transport pas encore facturé').length).toBeGreaterThan(0);
  });
});
