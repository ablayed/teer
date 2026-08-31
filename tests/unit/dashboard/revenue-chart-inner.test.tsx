// @vitest-environment jsdom

// TB-P0 — trois états, testés côte à côte, pour ne jamais confondre une erreur RPC
// (getRevenue30d en échec) avec un vrai « aucune livraison encaissée ».

import RevenueChartInner from '@/components/dashboard/RevenueChartInner';
import type { DashboardRevenue30d } from '@/lib/actions/dashboard';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const labels = {
  currency: null,
  emptyLabel: 'Aucune livraison encaissée sur les 30 derniers jours.',
  errorLabel: 'Données indisponibles',
  title: 'CA collecté sur 30 jours',
};

const revenue: DashboardRevenue30d = {
  currency: 'XOF',
  points: [{ date: '2026-08-01', value: 15_000 }],
};

afterEach(() => {
  cleanup();
});

describe('RevenueChartInner — TB-P0', () => {
  it('erreur : affiche l’indisponibilité, jamais l’état vide', () => {
    render(<RevenueChartInner state={{ errorCode: 'query_error', status: 'error' }} {...labels} />);

    expect(screen.getByText(labels.errorLabel)).toBeTruthy();
    expect(screen.queryByText(labels.emptyLabel)).toBeNull();
  });

  it('vide réel : affiche le libellé vide normal (contrôle positif)', () => {
    render(
      <RevenueChartInner
        state={{ data: { currency: 'XOF', points: [] }, status: 'empty' }}
        {...labels}
      />,
    );

    expect(screen.getByText(labels.emptyLabel)).toBeTruthy();
    expect(screen.queryByText(labels.errorLabel)).toBeNull();
  });

  it('données réelles : ne montre ni l’indisponibilité ni l’état vide', () => {
    render(<RevenueChartInner state={{ data: revenue, status: 'ready' }} {...labels} />);

    expect(screen.queryByText(labels.errorLabel)).toBeNull();
    expect(screen.queryByText(labels.emptyLabel)).toBeNull();
    expect(screen.getByText(labels.title)).toBeTruthy();
  });
});
