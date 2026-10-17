// @vitest-environment jsdom

import { ResourceRow } from '@/components/ui/resource-row';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

function carte(fullSurfaceLink: boolean) {
  return render(
    <ResourceRow
      fullSurfaceLink={fullSurfaceLink || undefined}
      href="/commandes/1"
      meta="CMD-1"
      overflow={<button type="button">Menu</button>}
      primaryAction={<span>12 500 F</span>}
      status={<span>À appeler</span>}
      testId="rangee"
      title="Fatou Diallo"
    />,
  );
}

describe('ResourceRow — fullSurfaceLink', () => {
  afterEach(cleanup);

  it('étend la zone du lien à la rangée par un pseudo-élément, sans changer le nom accessible', () => {
    carte(true);
    const lien = screen.getByRole('link');
    expect(lien.className).toContain('after:absolute');
    expect(lien.className).toContain('after:inset-0');
    expect(screen.getByTestId('rangee').className).toContain('relative');
    expect(lien.textContent).toContain('Fatou Diallo');
    expect(lien.getAttribute('aria-label')).toBeNull();
  });

  it('garde un seul lien dans la carte et un « ⋯ » séparé, au-dessus du lien', () => {
    carte(true);
    const rangee = screen.getByTestId('rangee');
    expect(within(rangee).getAllByRole('link')).toHaveLength(1);
    const menu = within(rangee).getByRole('button', { name: 'Menu' });
    expect(rangee.querySelector('a')?.contains(menu)).toBe(false);
    expect(menu.parentElement?.className).toContain('z-10');
    expect(menu.parentElement?.className).toContain('relative');
  });

  it('statut et montant sont hors du lien dans le DOM (zone couverte par le pseudo-élément)', () => {
    carte(true);
    const lien = screen.getByRole('link');
    expect(lien.contains(screen.getByText('À appeler'))).toBe(false);
    expect(lien.contains(screen.getByText('12 500 F'))).toBe(false);
  });

  it('sans la propriété, comportement historique inchangé', () => {
    carte(false);
    const lien = screen.getByRole('link');
    expect(lien.className).not.toContain('after:absolute');
    expect(screen.getByTestId('rangee').className).not.toContain('relative');
    expect(
      screen.getByRole('button', { name: 'Menu' }).parentElement?.className ?? '',
    ).not.toContain('z-10');
  });
});
