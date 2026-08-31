// @vitest-environment jsdom

// TB-P0 — le bloc « Priorités à traiter » ne doit jamais confondre une erreur RPC
// (getPriorityCounts en échec) avec un vrai zéro. Preuve des trois états, contrôle
// positif inclus (zéro réel ≠ erreur), et preuve que l'état d'erreur ne pose AUCUN lien
// de drill-down (décision produit figée : un compteur inconnu ne doit jamais laisser
// croire qu'une liste filtrée en est la population réelle).

import { OrderExceptionsGrid } from '@/components/dashboard/OrderExceptionsGrid';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const groupTitles = ['Urgences du jour', 'Livraison', 'Annulations & retours'];
const errorLabel = 'Données indisponibles';

afterEach(() => {
  cleanup();
});

describe('OrderExceptionsGrid — TB-P0', () => {
  it('erreur : affiche l’indisponibilité sur les trois cartes, sans lien de navigation', () => {
    render(
      <OrderExceptionsGrid
        errorLabel={errorLabel}
        groupTitles={groupTitles}
        status="error"
        title="Priorités à traiter"
      />,
    );

    expect(screen.getAllByText(errorLabel)).toHaveLength(3);
    for (const groupTitle of groupTitles) {
      expect(screen.getByText(groupTitle)).toBeTruthy();
    }
    // Aucune ancre : pas de navigation possible depuis un compteur inconnu.
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByText('0')).toBeNull();
  });

  it('zéro réel : affiche 0 sur chaque ligne avec ses liens de drill-down (contrôle positif)', () => {
    render(
      <OrderExceptionsGrid
        cards={[
          {
            rows: [
              { count: 0, href: '/commandes?vue=a-appeler', label: 'À appeler (7 j)' },
              { count: 0, href: '/commandes?vue=tentee-a-rappeler', label: 'À rappeler' },
            ],
            title: 'Urgences du jour',
          },
        ]}
        status="ready"
        title="Priorités à traiter"
      />,
    );

    expect(screen.queryByText(errorLabel)).toBeNull();
    expect(screen.getAllByText('0')).toHaveLength(2);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute('href')).toBe('/commandes?vue=a-appeler');
  });

  it('données réelles non nulles : affiche les compteurs et les liens correspondants', () => {
    render(
      <OrderExceptionsGrid
        cards={[
          {
            rows: [
              { count: 4, href: '/commandes?vue=annulees-retours', label: 'Annulées / Retours' },
            ],
            title: 'Annulations & retours',
          },
        ]}
        status="ready"
        title="Priorités à traiter"
      />,
    );

    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/commandes?vue=annulees-retours');
  });
});
