// @vitest-environment jsdom

import { KPICard } from '@/components/kpi/KPICard';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

expect.extend(toHaveNoViolations);

describe('KPICard', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(performance.now() + 1000);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('affiche le skeleton en chargement sans valeur', () => {
    render(<KPICard label="CA collecté" loading value={182500} unit="currency" />);

    expect(screen.getByTestId('kpi-value-skeleton')).toBeTruthy();
    expect(screen.queryByText(/182\s500\sF CFA/)).toBeNull();
  });

  it('formate une valeur XOF', async () => {
    render(<KPICard currency="XOF" label="CA collecté" value={182500} unit="currency" />);

    await waitFor(() => {
      expect(screen.getByText(/182\s500\sF CFA/)).toBeTruthy();
    });
  });

  it('force FCFA meme quand la devise stockee est USD (mono-devise)', async () => {
    render(<KPICard currency="USD" label="CA collecté" value={1825} unit="currency" />);

    await waitFor(() => {
      expect(screen.getByText(/1\s825\sF CFA/)).toBeTruthy();
    });
  });

  it('affiche un delta positif en vert', async () => {
    const { container } = render(<KPICard deltaPct={12} label="Taux confirmation" value={42} />);

    await waitFor(() => {
      expect(container.querySelector('[data-kpi-delta-tone="positive"]')).toBeTruthy();
    });
    expect(within(container).getByText('↑')).toBeTruthy();
  });

  it('inverse la couleur du delta absolu pour les appels', async () => {
    const { container } = render(
      <KPICard deltaAbs={3} deltaType="abs" invertDelta label="À appeler" value={8} />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-kpi-delta-tone="negative"]')).toBeTruthy();
    });
    expect(within(container).getByText('↑')).toBeTruthy();
  });

  it('TB-P0 : affiche l’indisponibilité en texte visible, jamais seulement au survol/title', () => {
    render(
      <KPICard error errorLabel="Données indisponibles" label="À appeler" unit="count" value={0} />,
    );

    // Le libellé est un texte de la page, lisible sans survol ni interaction — pas un `title`
    // de tooltip (invisible sur mobile) ni un simple tiret « — ».
    expect(screen.getByText('Données indisponibles')).toBeTruthy();
    expect(screen.queryByText('—')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.queryByTestId('kpi-value-skeleton')).toBeNull();
  });

  it('ne présente aucune violation axe serious ou critical', async () => {
    const { container } = render(
      <KPICard currency="XOF" label="CA collecté" value={182500} unit="currency" />,
    );

    const results = await axe(container);
    const seriousOrCritical = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );

    expect(seriousOrCritical).toHaveLength(0);
  });
});
