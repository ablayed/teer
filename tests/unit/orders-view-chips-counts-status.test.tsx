// @vitest-environment jsdom
//
// L04 — les pastilles de vue de /commandes quand leurs compteurs arrivent après la liste.
// Traduction état → rendu seulement ; le chemin applicatif est prouvé contre le vrai PostgREST
// par tests/rls/l04-orders-page-list-and-counts.rls.test.ts.
import { OrdersViewChips } from '@/components/orders/orders-view-chips';
import { orderSavedViews } from '@/lib/domain/order-saved-views';
import type { ViewCountsStatus } from '@/lib/orders/deferred-view-counts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const views = orderSavedViews.map((view, index) => ({
  count: index === 0 ? 43 : 0,
  id: view.id,
  label: view.label,
}));

function renderChips(countsStatus?: ViewCountsStatus) {
  return render(
    <OrdersViewChips
      activeView="toutes"
      countsStatus={countsStatus}
      onSelect={vi.fn()}
      pendingViewId={null}
      views={views}
    />,
  );
}

afterEach(cleanup);

describe('L04 — pastilles de vue selon l état des compteurs', () => {
  it('compteurs connus (défaut) : « Libellé (n) », zéro compris', () => {
    renderChips();
    expect(screen.getByRole('button', { name: `${views[0].label} (43)` })).toBeTruthy();
    expect(screen.getByRole('button', { name: `${views[1].label} (0)` })).toBeTruthy();
    expect(screen.getByRole('navigation').getAttribute('aria-busy')).toBeNull();
  });

  it('en attente : aucune pastille ne montre de nombre, et les vues restent cliquables', () => {
    renderChips('pending');
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(views.length);
    for (const button of buttons) {
      expect(button.textContent).not.toMatch(/\d/);
      expect((button as HTMLButtonElement).disabled).toBe(false);
    }
    expect(screen.getByRole('navigation').getAttribute('aria-busy')).toBe('true');
  });

  it('lecture échouée : un tiret, jamais « (0) »', () => {
    renderChips('error');
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent).toContain('(—)');
      expect(button.textContent).not.toMatch(/\d/);
    }
    expect(screen.getByRole('navigation').getAttribute('aria-busy')).toBeNull();
  });
});
