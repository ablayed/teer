// @vitest-environment jsdom

/**
 * Phase F — Lot F2, Task 7 : garde RBAC UI de l'entrée « Ajouter une dépense
 * publicitaire » sur `ProductDetailPanel` (miroir du serveur, ne le remplace
 * pas — la RPC/action serveur reste la source de vérité). Le gate lui-même
 * (`isOwner ? (...) : null`, product-detail-panel.tsx) a été posé comme effet
 * de bord de la Task 6 (formulaire de dépense publicitaire) ; ce fichier
 * verrouille son comportement avec un test dédié.
 *
 * Rendu avec `currentRole='manager'` puis `currentRole='agent'` : le bouton
 * est ABSENT du DOM (pas seulement masqué visuellement) — `queryByRole`
 * renvoie `null`. Rendu avec `currentRole='owner'` : le bouton est présent.
 */

import { ProductDetailPanel } from '@/components/products/product-detail-panel';
import type { ProductsPageItem } from '@/lib/actions/products';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// `@/lib/actions/products` et `@/lib/actions/purchases` sont des fichiers
// `'use server'` qui importent `env` (validé au chargement du module, cf.
// CLAUDE.md) — mockés au niveau des seuls exports utilisés par
// `ProductDetailPanel`, jamais réellement invoqués dans ces trois tests
// (rendu statique uniquement, aucune interaction de mutation).
vi.mock('@/lib/actions/products', () => ({
  getBundleCompositionAction: vi.fn(),
  saveBundleConfigurationAction: vi.fn(),
}));

vi.mock('@/lib/actions/purchases', () => ({
  getProductAdSpendCandidateLotsAction: vi.fn(),
}));

// `useAction` n'a besoin d'aucun vrai client d'action pour ces tests — seul
// son état initial (idle, `result: {}`) est lu au rendu ; `execute` est un
// no-op (les deux `useEffect` de `ProductDetailPanel` l'appellent
// inconditionnellement au montage, y compris pour manager/agent).
vi.mock('next-safe-action/hooks', () => ({
  useAction: () => ({
    execute: () => {},
    executeAsync: async () => ({ data: undefined }),
    isExecuting: false,
    isIdle: true,
    isPending: false,
    isTransitioning: false,
    result: {},
    status: 'idle',
    reset: () => {},
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

beforeAll(() => {
  // DetailPanel lit window.matchMedia via useIsDesktop — jsdom ne l'implémente
  // pas nativement (même stub que tests/unit/purchases/purchase-lot-detail-panel.test.tsx).
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

const product: ProductsPageItem = {
  id: 'prod-1',
  title: 'Robe wax imprimée',
  sku: 'SKU-001',
  unit_cost: 10_000,
  is_active: true,
  shopify_product_id: null,
  shopify_variant_id: null,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
  qtyOnHand: 20,
  qtyReserved: 0,
  qtyAvailable: 20,
  lowStockThreshold: 5,
  isLowStock: false,
  stockUnitCost: 10_000,
  stockValue: 200_000,
  isBundle: false,
  bundleAvailability: null,
};

const AD_SPEND_BUTTON_NAME = /Ajouter une dépense publicitaire/;

describe('ProductDetailPanel — garde RBAC UI de la dépense publicitaire', () => {
  it('n’affiche pas le bouton pour un manager (absent du DOM, pas seulement masqué)', () => {
    render(
      <ProductDetailPanel
        allProducts={[product]}
        currentRole="manager"
        onClose={() => {}}
        product={product}
      />,
    );

    expect(screen.queryByRole('button', { name: AD_SPEND_BUTTON_NAME })).toBeNull();
    expect(screen.queryByText(AD_SPEND_BUTTON_NAME)).toBeNull();
  });

  it('n’affiche pas le bouton pour un agent (absent du DOM, pas seulement masqué)', () => {
    render(
      <ProductDetailPanel
        allProducts={[product]}
        currentRole="agent"
        onClose={() => {}}
        product={product}
      />,
    );

    expect(screen.queryByRole('button', { name: AD_SPEND_BUTTON_NAME })).toBeNull();
    expect(screen.queryByText(AD_SPEND_BUTTON_NAME)).toBeNull();
  });

  it('affiche le bouton pour un owner', () => {
    render(
      <ProductDetailPanel
        allProducts={[product]}
        currentRole="owner"
        onClose={() => {}}
        product={product}
      />,
    );

    expect(screen.getByRole('button', { name: AD_SPEND_BUTTON_NAME })).toBeTruthy();
  });
});
