// @vitest-environment jsdom

/**
 * Phase F — Lot U1-F, §3.6 : cibles tactiles ≥48px CSS (`min-h-12`), espacement ≥8px CSS entre
 * cibles adjacentes. jsdom n'exécute pas le CSS réel — assertions sur les classes utilitaires
 * (convention déjà en usage dans le dépôt, ex. onboarding-flow.tsx, action-sheet.tsx).
 */

import { ListCard } from '@/components/ui/list-card';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
  cleanup();
});

describe('ListCard', () => {
  it('nom en tête, montant en évidence, secondaire replié par défaut', () => {
    render(
      <ListCard
        primaryValue="45 000 F CFA"
        secondary={[{ label: 'Statut', value: 'EN_LIVRAISON' }]}
        title="Fatou Diallo"
      />,
    );

    expect(screen.getByText('Fatou Diallo')).toBeTruthy();
    expect(screen.getByText('45 000 F CFA')).toBeTruthy();
    expect(screen.queryByText('Statut')).toBeNull();
  });

  it('déplié au tap sur "Détails" : le secondaire apparaît', () => {
    render(
      <ListCard
        primaryValue="45 000 F CFA"
        secondary={[{ label: 'Statut', value: 'EN_LIVRAISON' }]}
        title="Fatou Diallo"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Détails/ }));
    expect(screen.getByText('Statut')).toBeTruthy();
    expect(screen.getByText('EN_LIVRAISON')).toBeTruthy();
  });

  it('cibles tactiles ≥48px CSS (min-h-12) et espacement ≥8px CSS (gap-2 mini) entre cibles adjacentes', () => {
    render(
      <ListCard
        primaryValue="45 000 F CFA"
        secondary={[{ label: 'Statut', value: 'EN_LIVRAISON' }]}
        title="Fatou Diallo"
      />,
    );

    const toggle = screen.getByRole('button', { name: /Détails/ });
    expect(toggle.className).toContain('min-h-12');

    const row = toggle.closest('[data-testid="list-card"]');
    expect(row).toBeTruthy();
    const controlsRow = toggle.parentElement;
    expect(controlsRow?.className).toContain('gap-2');
  });

  it('sans secondaire : aucun toggle "Détails" (rien à replier)', () => {
    render(<ListCard primaryValue="12 500 F CFA" title="Moussa Ndiaye" />);
    expect(screen.queryByRole('button', { name: /Détails/ })).toBeNull();
  });
});
