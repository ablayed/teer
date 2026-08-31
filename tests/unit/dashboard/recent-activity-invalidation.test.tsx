// @vitest-environment jsdom

// Preuve de RENDU pour la décision 0116 « aucune ligne order_state_transition à
// l'invalidation ». Le bloc « Activité récente » de /tableau
// (components/dashboard/RecentActivity.tsx, alimenté par fetchRecentActivityForUser dans
// lib/actions/dashboard.ts, qui lit order_state_transition SANS filtre de statut) est le
// SEUL écran où le geste restait visible.
//
// Ce que ce fichier prouve, et que la couche RLS ne peut pas prouver : une fois la ligne
// A_APPELER absente, le bloc rend proprement — une entrée en moins, jamais une ligne vide,
// jamais un trou, jamais l'état vide alors qu'il reste des transitions.
// (Que la ligne soit bien absente en base est prouvé côté RLS,
// tests/rls/stock-atomicity.rls.test.ts, describe « 0116 - Invalider une commande livree ».)

import { RecentActivity } from '@/components/dashboard/RecentActivity';
import type { DashboardRecentActivityItem } from '@/lib/actions/dashboard';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const labels = {
  emptyLabel: 'Aucune transition récente.',
  errorLabel: 'Données indisponibles',
  initialLabel: 'Initial',
  orderFallbackLabel: 'Commande',
  title: 'Activité récente',
};

// Le parcours réel d'une commande invalidée : ses transitions normales subsistent, et
// l'invalidation n'en ajoute AUCUNE. C'est exactement ce que la requête remonte après 0116.
const transitionsAfterInvalidation: DashboardRecentActivityItem[] = [
  {
    id: 't3',
    createdAt: '2026-07-30T10:00:00.000Z',
    fromStatus: 'EN_LIVRAISON',
    orderNumber: '2921',
    toStatus: 'LIVREE',
  },
  {
    id: 't2',
    createdAt: '2026-07-30T09:00:00.000Z',
    fromStatus: 'PROGRAMMEE',
    orderNumber: '2921',
    toStatus: 'EN_LIVRAISON',
  },
  {
    id: 't1',
    createdAt: '2026-07-30T08:00:00.000Z',
    fromStatus: 'A_APPELER',
    orderNumber: '2921',
    toStatus: 'PROGRAMMEE',
  },
];

// Contre-exemple : ce que le bloc afficherait SI la ligne d'invalidation était posée.
const withInvalidationRow: DashboardRecentActivityItem[] = [
  {
    id: 't4',
    createdAt: '2026-07-30T11:00:00.000Z',
    fromStatus: 'LIVREE',
    orderNumber: '2921',
    toStatus: 'A_APPELER',
  },
  ...transitionsAfterInvalidation,
];

afterEach(() => {
  cleanup();
});

describe('0116 — « Activité récente » après une invalidation', () => {
  it("n'affiche aucune entrée « Livrée → À appeler » et rend les autres transitions intactes", () => {
    render(
      <RecentActivity
        state={{ data: transitionsAfterInvalidation, status: 'ready' }}
        {...labels}
      />,
    );

    const list = screen.getByRole('list');
    // Une entrée par transition remontée : 3 lignes pour 3 transitions, pas 4.
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    // Les transitions réelles de la commande sont bien là.
    expect(screen.getByText('#2921 · En livraison → Livrée')).toBeTruthy();
    expect(screen.getByText('#2921 · Programmée → En livraison')).toBeTruthy();
    expect(screen.getByText('#2921 · À appeler → Programmée')).toBeTruthy();
    // La signature de l'invalidation est absente.
    expect(screen.queryByText('#2921 · Livrée → À appeler')).toBeNull();
    // Et le bloc n'est pas tombé dans son état vide alors qu'il reste des transitions.
    expect(screen.queryByText(labels.emptyLabel)).toBeNull();
  });

  it('rend exactement une entrée de moins que si la ligne était posée — aucune ligne vide, aucun trou', () => {
    const { unmount } = render(
      <RecentActivity state={{ data: withInvalidationRow, status: 'ready' }} {...labels} />,
    );
    const withRow = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(withRow).toHaveLength(4);
    expect(screen.getByText('#2921 · Livrée → À appeler')).toBeTruthy();
    unmount();

    render(
      <RecentActivity
        state={{ data: transitionsAfterInvalidation, status: 'ready' }}
        {...labels}
      />,
    );
    const withoutRow = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(withoutRow).toHaveLength(3);
    // Chaque <li> restant porte un libellé complet (« X → Y ») et une date : la suppression
    // de la ligne d'invalidation ne laisse ni entrée vide ni libellé tronqué.
    for (const item of withoutRow) {
      expect(item.textContent).toMatch(/#2921 · .+ → .+/);
      expect(item.textContent?.trim().length).toBeGreaterThan(10);
    }
  });

  it("affiche son état vide normal quand il ne reste aucune transition — pas d'erreur de rendu", () => {
    render(<RecentActivity state={{ data: [], status: 'empty' }} {...labels} />);
    expect(screen.getByText(labels.emptyLabel)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('TB-P0 : distingue une erreur RPC d’un résultat vide — jamais un repli silencieux sur []', () => {
    render(<RecentActivity state={{ errorCode: 'query_error', status: 'error' }} {...labels} />);
    // L'indisponibilité est un TEXTE visible, jamais seulement une teinte ou un état vide muet.
    expect(screen.getByText(labels.errorLabel)).toBeTruthy();
    expect(screen.queryByText(labels.emptyLabel)).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
