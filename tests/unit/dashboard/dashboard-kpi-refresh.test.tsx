// @vitest-environment jsdom

// TB-P0 — la bande KPI ne doit plus confondre l'échec du chargement SERVEUR initial
// (getDashboardKpi en échec, avant tout refresh client) avec un vrai zéro : avant ce
// lot, `kpiResult.ok ? kpiResult.data : null` faisait perdre l'échec dès l'arrivée sur
// la page, `hasError` ne regardant que `kpiAction.result.data` (le refresh client à
// 60 s), jamais absent au premier rendu.

import { DashboardKpiRefresh } from '@/components/kpi/dashboard-kpi-refresh';
import type { DashboardKpi } from '@/lib/actions/dashboard';
import messages from '@/messages/fr.json';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/actions/dashboard', () => ({
  getDashboardKpiAction: vi.fn(),
}));

vi.mock('next-safe-action/hooks', () => ({
  // Aucun refresh client n'a encore eu lieu dans ces tests : result.data reste undefined,
  // exactement l'état au premier rendu serveur → client.
  useAction: () => ({
    execute: vi.fn(),
    isExecuting: false,
    result: { data: undefined },
  }),
}));

const kpiZero: DashboardKpi = {
  a_appeler_count: 0,
  a_appeler_delta: 0,
  ca_en_attente: 0,
  currency: 'XOF',
  taux_confirmation: 0,
  taux_livraison: 0,
};

const kpiNonZero: DashboardKpi = {
  a_appeler_count: 6,
  a_appeler_delta: 2,
  ca_en_attente: 120_000,
  currency: 'XOF',
  taux_confirmation: 0.8,
  taux_livraison: 0.75,
};

function renderStrip(props: { initialError: boolean; initialKpi: DashboardKpi | null }) {
  return render(
    <NextIntlClientProvider locale="fr" messages={messages}>
      <DashboardKpiRefresh initialUpdatedAt="2026-08-31T10:00:00.000Z" shopId={null} {...props} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('DashboardKpiRefresh — TB-P0', () => {
  it('erreur au chargement initial : les cartes affichent l’indisponibilité en texte visible, jamais 0', () => {
    renderStrip({ initialError: true, initialKpi: null });

    // Texte de page, lisible sans survol — pas un `title` de tooltip (invisible sur mobile).
    expect(screen.getAllByText('Données indisponibles').length).toBeGreaterThan(0);
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.queryByText('—')).toBeNull();
  });

  it('zéro réel : affiche bien 0, sans aucune mention d’indisponibilité (contrôle positif)', () => {
    renderStrip({ initialError: false, initialKpi: kpiZero });

    expect(screen.queryByText('Données indisponibles')).toBeNull();
    expect(screen.getByText('0')).toBeTruthy();
  });

  it('données réelles non nulles : affiche les valeurs, sans indisponibilité', () => {
    renderStrip({ initialError: false, initialKpi: kpiNonZero });

    expect(screen.queryByText('Données indisponibles')).toBeNull();
    expect(screen.getByText('6')).toBeTruthy();
  });
});
