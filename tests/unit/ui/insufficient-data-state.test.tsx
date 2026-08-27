// @vitest-environment jsdom

/**
 * Phase F — Lot U1-F, §3.7 : « volume insuffisant » est un état distinct de « aucune donnée »
 * (components/ui/empty-state.tsx, réutilisé tel quel, non modifié par ce lot). Le seuil n'est pas
 * décidé ici — F2b le fixera avec le marchand — le composant l'accepte en paramètre.
 */

import {
  InsufficientDataState,
  hasSufficientVolume,
} from '@/components/ui/insufficient-data-state';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
  cleanup();
});

describe('hasSufficientVolume', () => {
  it.each([
    [3, 10, false],
    [10, 10, true],
    [11, 10, true],
    [0, 1, false],
  ])('observedCount=%i, minimumRequired=%i -> %s', (observedCount, minimumRequired, expected) => {
    expect(hasSufficientVolume(observedCount, minimumRequired)).toBe(expected);
  });
});

describe('InsufficientDataState', () => {
  it('volume insuffisant : affiche le message générique, sans jargon', () => {
    render(<InsufficientDataState minimumRequired={10} observedCount={3} />);
    expect(screen.getByText('Pas encore assez de données pour analyser.')).toBeTruthy();
  });

  it('volume suffisant : ne rend rien (F2 décide quoi afficher à la place)', () => {
    const { container } = render(<InsufficientDataState minimumRequired={10} observedCount={10} />);
    expect(container.textContent).toBe('');
  });
});
