// @vitest-environment jsdom

/**
 * Phase F — Lot U1-F, preuves 5.2/5.3. La preuve de compilation (missing ne peut pas porter de
 * montant, estimated exige son libellé) est dans tests/types/value-state-contracts.ts (vérifiée
 * par `pnpm typecheck`). Ici : preuve de rendu — missing ne rend jamais de montant/calcul dérivé,
 * estimated porte un libellé texte, pas seulement une teinte.
 */

import { ValueAmount } from '@/components/ui/value-state';
import { formatMoney } from '@/lib/format/fcfa';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
  cleanup();
});

describe('ValueAmount', () => {
  it('confirmé : rend le montant sans ornement', () => {
    render(<ValueAmount state={{ kind: 'confirmed', amountMinor: 50_000 }} />);
    expect(screen.getByTestId('amount').textContent).toBe(formatMoney(50_000));
  });

  it('estimé : porte le montant approché ET un libellé texte (pas seulement une teinte)', () => {
    render(
      <ValueAmount state={{ kind: 'estimated', amountMinor: 50_000, label: 'Coût à confirmer' }} />,
    );
    expect(screen.getByTestId('amount').textContent).toBe(formatMoney(50_000));
    // Le libellé doit être un texte lisible dans le DOM, pas seulement une classe de couleur.
    expect(screen.getByText('Coût à confirmer')).toBeTruthy();
  });

  it('manquant : ne rend JAMAIS de montant ni de calcul dérivé, seulement le tiret + un libellé', () => {
    render(<ValueAmount state={{ kind: 'missing', label: 'Coût non renseigné' }} />);

    expect(screen.queryByTestId('amount')).toBeNull();
    expect(screen.queryByText(/\d/)).toBeNull();
    expect(screen.getByText('Coût non renseigné')).toBeTruthy();
    expect(screen.getByTestId('value-state-missing')).toBeTruthy();
  });

  it('manquant sans libellé fourni : retombe sur un libellé générique, jamais un montant', () => {
    render(<ValueAmount state={{ kind: 'missing' }} />);

    expect(screen.queryByTestId('amount')).toBeNull();
    expect(screen.getByText('Non renseigné')).toBeTruthy();
  });

  it('les trois états rendent des libellés différents (contrôle positif — pas un texte figé)', () => {
    const { unmount } = render(
      <ValueAmount state={{ kind: 'estimated', amountMinor: 1, label: 'Coût à confirmer' }} />,
    );
    expect(screen.getByTestId('value-state-estimated')).toBeTruthy();
    unmount();

    render(<ValueAmount state={{ kind: 'missing', label: 'Coût non renseigné' }} />);
    expect(screen.getByTestId('value-state-missing')).toBeTruthy();
  });
});
