// @vitest-environment jsdom

/**
 * Phase F — Lot U1-F, §3.3 : signe ET libellé, en plus de la couleur — pour les personnes qui ne
 * distinguent pas rouge/vert et pour la lecture en plein soleil. Contrôle positif inclus : les
 * trois états rendent des textes différents, pas un texte figé qui s'afficherait toujours.
 */

import { GainLoss } from '@/components/ui/gain-loss';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const labels = { gain: 'Gain', loss: 'Perte', neutral: 'Stable' };

afterEach(() => {
  cleanup();
});

describe('GainLoss', () => {
  it('gain : signe +, libellé texte, teinte succès (jamais orange, jamais rouge)', () => {
    render(<GainLoss amountMinor={89_360} labels={labels} />);

    const el = screen.getByTestId('gain-loss');
    expect(el.textContent).toContain('+');
    expect(screen.getByText('Gain')).toBeTruthy();
    expect(el.className).toContain('text-success');
    expect(el.className).not.toContain('text-accent');
    expect(el.className).not.toContain('text-danger');
  });

  it('perte : signe −, libellé texte, teinte ambre — jamais rouge (rouge réservé aux anomalies réelles)', () => {
    render(<GainLoss amountMinor={-15_000} labels={labels} />);

    const el = screen.getByTestId('gain-loss');
    expect(el.textContent).toContain('−');
    expect(screen.getByText('Perte')).toBeTruthy();
    expect(el.className).toContain('text-warning');
    expect(el.className).not.toContain('text-danger');
  });

  it('neutre : aucun signe, libellé texte distinct, teinte neutre', () => {
    render(<GainLoss amountMinor={0} labels={labels} />);

    const el = screen.getByTestId('gain-loss');
    expect(el.textContent).not.toContain('+');
    expect(el.textContent).not.toContain('−');
    expect(screen.getByText('Stable')).toBeTruthy();
    expect(el.className).toContain('text-muted');
  });

  it('les trois états rendent des libellés différents (pas un texte figé)', () => {
    const { unmount } = render(<GainLoss amountMinor={1} labels={labels} />);
    expect(screen.getByText('Gain')).toBeTruthy();
    unmount();

    render(<GainLoss amountMinor={-1} labels={labels} />);
    expect(screen.getByText('Perte')).toBeTruthy();
  });
});
