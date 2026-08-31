// @vitest-environment jsdom

// TB-P0 — trois états, testés côte à côte, pour ne jamais confondre une erreur RPC
// (getTopProducts en échec) avec une vraie absence de vente sur la période.

import { TopProducts } from '@/components/dashboard/TopProducts';
import type { DashboardTopProduct } from '@/lib/actions/dashboard';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const labels = {
  currency: null,
  emptyLabel: 'Aucun produit vendu pour le moment.',
  errorLabel: 'Données indisponibles',
  title: 'Produits les plus vendus',
  unitsLabel: 'unités',
};

const items: DashboardTopProduct[] = [{ name: 'Souris ergonomique', revenue: 12_000, units: 3 }];

afterEach(() => {
  cleanup();
});

describe('TopProducts — TB-P0', () => {
  it('erreur : affiche l’indisponibilité, jamais la liste vide ni un chiffre', () => {
    render(<TopProducts state={{ errorCode: 'not_found', status: 'error' }} {...labels} />);

    expect(screen.getByText(labels.errorLabel)).toBeTruthy();
    expect(screen.queryByText(labels.emptyLabel)).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('vide réel : affiche le libellé vide normal (contrôle positif)', () => {
    render(<TopProducts state={{ data: [], status: 'empty' }} {...labels} />);

    expect(screen.getByText(labels.emptyLabel)).toBeTruthy();
    expect(screen.queryByText(labels.errorLabel)).toBeNull();
  });

  it('données réelles : affiche les produits, sans mention d’erreur ni d’état vide', () => {
    render(<TopProducts state={{ data: items, status: 'ready' }} {...labels} />);

    expect(screen.getByText('Souris ergonomique')).toBeTruthy();
    expect(screen.queryByText(labels.errorLabel)).toBeNull();
    expect(screen.queryByText(labels.emptyLabel)).toBeNull();
  });
});
