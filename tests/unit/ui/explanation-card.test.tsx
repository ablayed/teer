// @vitest-environment jsdom

/**
 * Phase F — Lot U1-F, preuve 5.6 (cœur mutation-testé du lot) : le total n'est jamais une prop,
 * il est dérivé des lignes par `computeExplanationTotal`. Une seule ligne `missing` suffit à
 * rendre le total `missing` — impossible de produire un total sur des lignes incomplètes.
 *
 * Mutation testée manuellement pendant l'implémentation : commenter
 * `rows.some((row) => row.state.kind === 'missing')` dans computeExplanationTotal (et le
 * remplacer par `false`) fait échouer "ne montre jamais de total sur des lignes incomplètes"
 * (le total redevient un chiffre) — rapporté dans le rapport de fin de lot.
 */

import {
  ExplanationCard,
  type ExplanationCardRow,
  computeExplanationTotal,
} from '@/components/ui/explanation-card';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  // DetailPanel (réutilisé par ExplanationCard) lit window.matchMedia via useIsDesktop — jsdom
  // ne l'implémente pas nativement. Stub minimal local à ce fichier, aucune dépendance ajoutée.
  window.matchMedia =
    window.matchMedia ??
    ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
});

afterEach(() => {
  cleanup();
});

const completeRows: ExplanationCardRow[] = [
  { sentence: 'Tu as encaissé', sign: 'add', state: { kind: 'confirmed', amountMinor: 408_000 } },
  {
    sentence: 'Les articles vendus t’ont coûté',
    sign: 'subtract',
    state: { kind: 'confirmed', amountMinor: 251_940 },
  },
  {
    sentence: 'La publicité t’a coûté',
    sign: 'subtract',
    state: { kind: 'confirmed', amountMinor: 66_700 },
  },
];

describe('computeExplanationTotal', () => {
  it('somme signée quand toutes les lignes sont confirmées (contrôle positif)', () => {
    expect(computeExplanationTotal(completeRows)).toEqual({
      kind: 'confirmed',
      amountMinor: 89_360,
    });
  });

  it('total manquant dès qu’UNE ligne est manquante — jamais de montant inventé', () => {
    const rowsWithGap: ExplanationCardRow[] = [
      ...completeRows,
      { sentence: 'Autre coût', sign: 'subtract', state: { kind: 'missing' } },
    ];

    const total = computeExplanationTotal(rowsWithGap);
    expect(total.kind).toBe('missing');
    expect('amountMinor' in total).toBe(false);
  });

  it('total estimé si aucune ligne manquante mais au moins une estimée', () => {
    const rowsWithEstimate: ExplanationCardRow[] = [
      completeRows[0],
      {
        sentence: 'La publicité t’a coûté',
        sign: 'subtract',
        state: { kind: 'estimated', amountMinor: 66_700, label: 'Coût à confirmer' },
      },
    ];

    const total = computeExplanationTotal(rowsWithEstimate);
    expect(total.kind).toBe('estimated');
  });
});

describe('ExplanationCard', () => {
  it('affiche le total en tête et le rend accessible via un seul bouton discret', () => {
    render(<ExplanationCard label="Marge" rows={completeRows} totalSentence="Il te reste" />);

    expect(screen.getByText('Marge')).toBeTruthy();
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy();
    expect(screen.getByText(/89 360 F CFA/)).toBeTruthy();
  });

  it('déplié : montre chaque ligne en phrase avec son montant, puis le total en emphase', () => {
    render(<ExplanationCard label="Marge" rows={completeRows} totalSentence="Il te reste" />);

    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByText('Tu as encaissé')).toBeTruthy();
    expect(screen.getByText('Il te reste')).toBeTruthy();
  });

  it('ne montre JAMAIS de total sur des lignes incomplètes : le chiffre disparaît, un message apparaît', () => {
    const rowsWithGap: ExplanationCardRow[] = [
      ...completeRows,
      { sentence: 'Autre coût', sign: 'subtract', state: { kind: 'missing' } },
    ];

    render(<ExplanationCard label="Marge" rows={rowsWithGap} totalSentence="Il te reste" />);

    expect(screen.queryByText(/89 360 F CFA/)).toBeNull();
    expect(screen.getByText('Il manque des coûts')).toBeTruthy();
  });
});
