// @vitest-environment jsdom

/**
 * Phase F — Lot A1 : « ne plus afficher de chiffre faux ».
 *
 * Test central du lot, point de sortie « écran Finances » (ProfitSection). Preuve
 * mutation-testée (rapportée dans le rapport de fin de lot, pas ici) : commenter le
 * `coverageIncomplete ? <MaskedProfitRow .../> : <ProfitRow .../>` dans ProfitSection.tsx (revenir
 * à l'ancien rendu inconditionnel) fait échouer `masque la marge et le résultat net...` — la marge
 * fausse (81,7 %) redevient visible. Contrôle positif inclus : `affiche la marge et le résultat
 * net...` prouve que le masquage n'est pas un texte figé qui s'afficherait même à couverture
 * complète.
 */

import { ProfitSection } from '@/components/finance/ProfitSection';
import type { FinanceReport } from '@/lib/finance/profit';
import messages from '@/messages/fr.json';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}));

afterEach(() => {
  cleanup();
});

function baseReport(overrides: Partial<FinanceReport>): FinanceReport {
  return {
    caMinor: 495_405,
    deliveryFeesMinor: 0,
    returnContraRevenueMinor: 0,
    netCAMinor: 495_405,
    cogsMinor: 90_470,
    returnedCogsReversalMinor: 0,
    netCogsMinor: 90_470,
    grossMarginMinor: 404_935,
    grossMarginBps: 8_173,
    mobileMoneyFeesMinor: 0,
    expensesMinor: 0,
    expensesByCategory: [],
    netProfitMinor: 404_935,
    productBreakdown: [],
    cogsEstimated: false,
    cogsEstimatedMinor: 0,
    cogsCostedOrderCount: 0,
    cogsExcludedOrderCount: 0,
    cogsUnknownLineCount: 0,
    ...overrides,
  };
}

function renderProfitSection(report: FinanceReport) {
  return render(
    <NextIntlClientProvider locale="fr" messages={messages}>
      <ProfitSection from="2026-08-01" report={report} storeId="store-1" to="2026-08-27" />
    </NextIntlClientProvider>,
  );
}

describe('ProfitSection — Lot A1 (règle binaire de masquage)', () => {
  it('masque la marge et le résultat net dès qu’une commande est exclue du COGS', () => {
    // Reproduit exactement le cas de production du 27 août 2026 (11 commandes encaissées
    // sans coût de revient connu) qui affichait une marge de 81,7 % — chiffre faux, pas approximatif.
    renderProfitSection(baseReport({ cogsExcludedOrderCount: 11, cogsUnknownLineCount: 14 }));

    expect(screen.queryByText(/404\s?935/)).toBeNull();
    expect(screen.queryByText(/81,7\s?%/)).toBeNull();
    expect(screen.getAllByText('Indisponible — coûts incomplets').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Renseigner les coûts manquants')).toBeTruthy();
    // Le détail de ce qui manque reste affiché (ce n'est pas juste caché, c'est actionnable).
    expect(screen.getByText(/11 commandes encaissées sans coût de revient connu/)).toBeTruthy();
    expect(screen.getByText(/14 lignes vendues sans coût de revient/)).toBeTruthy();
  });

  it('affiche la marge et le résultat net quand la couverture est complète (contrôle positif)', () => {
    renderProfitSection(baseReport({ cogsExcludedOrderCount: 0, cogsUnknownLineCount: 0 }));

    expect(screen.queryByText('Indisponible — coûts incomplets')).toBeNull();
    expect(screen.getAllByText(/404\s?935\s?F CFA/).length).toBeGreaterThanOrEqual(2);
  });
});
