// @vitest-environment jsdom

// TB-P0 — trois états, testés côte à côte, pour ne jamais confondre une erreur RPC
// (getShopPerformance en échec) avec une vraie absence de boutique connectée.

import { ShopPerformance } from '@/components/dashboard/ShopPerformance';
import type { DashboardShopPerformance } from '@/lib/actions/dashboard';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const labels = {
  connectedLabel: 'Connectée',
  currency: null,
  emptyLabel: 'Aucune boutique connectée.',
  errorLabel: 'Données indisponibles',
  ordersLabel: 'commandes',
  title: 'Performance par boutique',
  warningLabel: 'À vérifier',
};

const items: DashboardShopPerformance[] = [
  { id: 'shop-1', name: 'Boutique Dakar', ordersCount: 7, revenue: 45_000, status: 'connected' },
];

afterEach(() => {
  cleanup();
});

describe('ShopPerformance — TB-P0', () => {
  it('erreur : affiche l’indisponibilité, jamais la liste vide', () => {
    render(<ShopPerformance state={{ errorCode: 'not_found', status: 'error' }} {...labels} />);

    expect(screen.getByText(labels.errorLabel)).toBeTruthy();
    expect(screen.queryByText(labels.emptyLabel)).toBeNull();
  });

  it('vide réel : affiche le libellé vide normal (contrôle positif)', () => {
    render(<ShopPerformance state={{ data: [], status: 'empty' }} {...labels} />);

    expect(screen.getByText(labels.emptyLabel)).toBeTruthy();
    expect(screen.queryByText(labels.errorLabel)).toBeNull();
  });

  it('données réelles : affiche les boutiques, sans mention d’erreur ni d’état vide', () => {
    render(<ShopPerformance state={{ data: items, status: 'ready' }} {...labels} />);

    expect(screen.getByText('Boutique Dakar')).toBeTruthy();
    expect(screen.queryByText(labels.errorLabel)).toBeNull();
    expect(screen.queryByText(labels.emptyLabel)).toBeNull();
  });
});
