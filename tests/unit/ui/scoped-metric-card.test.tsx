// @vitest-environment jsdom

/**
 * Phase F — Lot U1-F, §3.4 / preuve 5.5. La preuve de compilation (une carte sans `scope` ne
 * compile pas) est dans tests/types/scoped-metric-card-contracts.tsx (vérifiée par `pnpm
 * typecheck`). Ici : le sous-titre de portée est toujours visible et distingue solde/flux par un
 * texte différent (pas seulement une icône), pour ne jamais confondre les deux familles.
 */

import { ScopedMetricCard } from '@/components/ui/scoped-metric-card';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
  cleanup();
});

describe('ScopedMetricCard', () => {
  it('solde : sous-titre "Solde au ..." toujours visible', () => {
    render(
      <ScopedMetricCard
        label="Argent chez le livreur"
        scope={{ kind: 'balance', asOfLabel: '27 août 2026' }}
        value="1 539 116 F CFA"
      />,
    );

    expect(screen.getByText('Solde au 27 août 2026')).toBeTruthy();
  });

  it('flux : sous-titre "Sur ..." toujours visible, texte distinct du solde', () => {
    render(
      <ScopedMetricCard
        label="CA encaissé"
        scope={{ kind: 'flow', periodLabel: '30 derniers jours' }}
        value="495 405 F CFA"
      />,
    );

    expect(screen.getByText('Sur 30 derniers jours')).toBeTruthy();
    expect(screen.queryByText(/^Solde au/)).toBeNull();
  });
});
