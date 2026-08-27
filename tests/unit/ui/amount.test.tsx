// @vitest-environment jsdom

/**
 * Phase F — Lot U1-F, preuve 5.1 : le composant Amount rend le montant avec espace insécable,
 * sans décimale, symbole après. Le test échoue si le format change (comparaison exacte du
 * textContent, pas getByText — le normalizer par défaut de testing-library collapse l'espace
 * insécable vers un espace normal via /\s+/, ce qui masquerait justement une régression vers un
 * espace normal).
 */

import { Amount } from '@/components/ui/amount';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const NARROW_NO_BREAK_SPACE = ' ';

afterEach(() => {
  cleanup();
});

describe('Amount', () => {
  it('rend le montant avec espace insécable, sans décimale, symbole après', () => {
    render(<Amount amountMinor={1_245_000} />);

    expect(screen.getByTestId('amount').textContent).toBe(
      `1${NARROW_NO_BREAK_SPACE}245${NARROW_NO_BREAK_SPACE}000${NARROW_NO_BREAK_SPACE}F CFA`,
    );
  });

  it('échoue si un format à espace normal ou avec décimales est utilisé (contrôle négatif)', () => {
    render(<Amount amountMinor={1_245_000} />);

    const text = screen.getByTestId('amount').textContent ?? '';
    expect(text).not.toBe('1 245 000 F CFA');
    expect(text).not.toMatch(/[.,]00/);
  });

  it('applique les utilitaires de chiffres tabulaires en classe (mesure réelle : Playwright)', () => {
    render(<Amount amountMinor={888_888} />);

    const el = screen.getByTestId('amount');
    expect(el.className).toContain('tabular-nums');
    expect(el.className).toContain('lining-nums');
    expect(el.className).toContain('font-sans');
    expect(el.className).not.toContain('font-display');
    expect(el.className).not.toContain('italic');
  });

  it('abbreviateForAxis bascule vers le format compact, jamais par défaut', () => {
    render(<Amount amountMinor={1_245_000} />);
    expect(screen.getByTestId('amount').textContent).not.toMatch(/1,2\s?M/);

    cleanup();
    render(<Amount abbreviateForAxis amountMinor={1_245_000} />);
    expect(screen.getByTestId('amount').textContent).toMatch(/1,2\s?M\s?F CFA/);
  });
});
