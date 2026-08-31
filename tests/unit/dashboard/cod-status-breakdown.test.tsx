// @vitest-environment jsdom

// TB-P0 — trois états, testés côte à côte, pour ne jamais confondre une erreur RPC
// (getCodBreakdown en échec) avec un vrai « aucune commande ».

import { CODStatusBreakdown } from '@/components/dashboard/CODStatusBreakdown';
import type { DashboardCodBreakdownItem } from '@/lib/actions/dashboard';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const labels = {
  emptyLabel: 'Aucune commande à afficher.',
  errorLabel: 'Données indisponibles',
  title: 'Répartition COD',
};

const items: DashboardCodBreakdownItem[] = [
  { count: 5, status: 'A_APPELER' },
  { count: 2, status: 'LIVREE' },
];

afterEach(() => {
  cleanup();
});

describe('CODStatusBreakdown — TB-P0', () => {
  it('erreur : affiche l’indisponibilité, jamais l’état vide', () => {
    render(<CODStatusBreakdown state={{ errorCode: 'not_found', status: 'error' }} {...labels} />);

    expect(screen.getByText(labels.errorLabel)).toBeTruthy();
    expect(screen.queryByText(labels.emptyLabel)).toBeNull();
  });

  it('vide réel : affiche le libellé vide normal (contrôle positif)', () => {
    render(<CODStatusBreakdown state={{ data: [], status: 'empty' }} {...labels} />);

    expect(screen.getByText(labels.emptyLabel)).toBeTruthy();
    expect(screen.queryByText(labels.errorLabel)).toBeNull();
  });

  it('données réelles : affiche la répartition, sans mention d’erreur ni d’état vide', () => {
    render(<CODStatusBreakdown state={{ data: items, status: 'ready' }} {...labels} />);

    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.queryByText(labels.errorLabel)).toBeNull();
    expect(screen.queryByText(labels.emptyLabel)).toBeNull();
  });
});
