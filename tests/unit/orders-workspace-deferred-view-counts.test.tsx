// @vitest-environment jsdom
//
// L04 — l'espace de travail de /commandes quand ses compteurs de vue arrivent APRÈS la liste.
// Le vrai `OrdersWorkspace` est rendu, avec sa limite Suspense et sa lecture `use(promesse)`.
// Substitués : la liste elle-même (hors sujet ici), la navigation Next et les actions serveur.
import { OrdersWorkspace } from '@/components/orders/orders-workspace';
import type { DeferredOrderViewCounts } from '@/lib/actions/orders';
import { orderSavedViewIds, orderSavedViews } from '@/lib/domain/order-saved-views';
import type { OrderSavedViewId } from '@/lib/domain/order-saved-views';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

type LoaderProps = {
  onTransitionApplied: (change: { nextOrder: unknown; previousOrder: unknown }) => void;
};
const harness = vi.hoisted(() => ({ loader: null as LoaderProps | null }));

vi.mock('@/components/orders/orders-page-loader', () => ({
  OrdersPageLoader: (props: LoaderProps) => {
    harness.loader = props;
    return <div data-testid="liste">liste</div>;
  },
}));
vi.mock('@/components/orders/orders-board-context', () => ({ useOrdersBoard: () => null }));
vi.mock('@/lib/actions/orders', () => ({ getOrdersPageData: vi.fn() }));
vi.mock('@/lib/orders/search-client', () => ({ fetchOrdersSearchPageData: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/commandes',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const counts = (toutes: number) =>
  Object.fromEntries(orderSavedViewIds.map((id) => [id, id === 'toutes' ? toutes : 1])) as Record<
    OrderSavedViewId,
    number
  >;
const placeholders = orderSavedViews.map((view) => ({ count: 0, id: view.id, label: view.label }));
const toutes = orderSavedViews[0].label;

function deferred() {
  let resolve: (value: DeferredOrderViewCounts) => void = () => undefined;
  const promise = new Promise<DeferredOrderViewCounts>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Props = ComponentProps<typeof OrdersWorkspace>;
function props(overrides: Partial<Props>): Props {
  return {
    activePeriod: '30j',
    activeView: 'toutes',
    canReassign: false,
    dateFrom: '2026-03-01T00:00:00.000Z',
    dateTo: '2026-03-31T23:59:59.999Z',
    deferredViewCounts: null,
    drivers: [],
    emptyValueLabel: '—',
    initialHasMore: false,
    initialNextCursor: null,
    initialOrders: [],
    initialReliabilityTiers: {},
    reliabilityLabels: { new: 'n', reliable: 'r', risk: 'x', watch: 'w' },
    searchLabels: {
      ariaLabel: 'Rechercher',
      clear: 'Effacer',
      placeholder: 'Rechercher',
    } as Props['searchLabels'],
    searchQuery: '',
    selectedShopId: 'shop-a',
    views: placeholders,
    ...overrides,
  };
}

const chips = () => screen.getByRole('navigation', { name: 'Vues commandes' });
const chipTexts = () =>
  Array.from(chips().querySelectorAll('button')).map((button) => button.textContent ?? '');
async function settle(resolve: () => void) {
  await act(async () => {
    resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  harness.loader = null;
});

describe('L04 — compteurs de vue arrivant après la liste', () => {
  it('la liste est rendue sans attendre ; les pastilles ne montrent aucun nombre, puis les compteurs', async () => {
    const first = deferred();
    await act(async () => {
      render(<OrdersWorkspace {...props({ deferredViewCounts: first.promise })} />);
    });
    expect(screen.getByTestId('liste')).toBeTruthy();
    expect(chips().getAttribute('data-counts-status')).toBe('pending');
    for (const text of chipTexts()) expect(text).not.toMatch(/\d/);

    await settle(() => first.resolve({ counts: counts(43), ok: true }));
    expect(await screen.findByRole('button', { name: `${toutes} (43)` })).toBeTruthy();
    expect(chips().getAttribute('data-counts-status')).toBe('ready');
  });

  it('lecture échouée : un tiret, jamais « (0) », et la liste reste là', async () => {
    const first = deferred();
    await act(async () => {
      render(<OrdersWorkspace {...props({ deferredViewCounts: first.promise })} />);
    });
    await settle(() => first.resolve({ ok: false }));
    expect(await screen.findByRole('button', { name: `${toutes} (—)` })).toBeTruthy();
    for (const text of chipTexts()) expect(text).not.toMatch(/\d/);
    expect(screen.getByTestId('liste')).toBeTruthy();
  });

  it('nouvelle lecture pour la MÊME période : les compteurs restent affichés, puis sont remplacés', async () => {
    const first = deferred();
    const view = await act(async () =>
      render(<OrdersWorkspace {...props({ deferredViewCounts: first.promise })} />),
    );
    await settle(() => first.resolve({ counts: counts(43), ok: true }));
    await screen.findByRole('button', { name: `${toutes} (43)` });

    const second = deferred();
    await act(async () => {
      view.rerender(
        <OrdersWorkspace
          {...props({ activeView: 'a-appeler', deferredViewCounts: second.promise })}
        />,
      );
    });
    expect(screen.getByRole('button', { name: `${toutes} (43)` })).toBeTruthy();

    await settle(() => second.resolve({ counts: counts(44), ok: true }));
    expect(await screen.findByRole('button', { name: `${toutes} (44)` })).toBeTruthy();
  });

  it('nouvelle lecture pour une AUTRE période : aucun nombre de l ancienne période n est montré', async () => {
    const first = deferred();
    const view = await act(async () =>
      render(<OrdersWorkspace {...props({ deferredViewCounts: first.promise })} />),
    );
    await settle(() => first.resolve({ counts: counts(43), ok: true }));
    await screen.findByRole('button', { name: `${toutes} (43)` });

    const second = deferred();
    await act(async () => {
      view.rerender(
        <OrdersWorkspace
          {...props({
            activePeriod: '7j',
            dateFrom: '2026-04-01T00:00:00.000Z',
            dateTo: '2026-04-07T23:59:59.999Z',
            deferredViewCounts: second.promise,
          })}
        />,
      );
    });
    expect(chips().getAttribute('data-counts-status')).toBe('pending');
    for (const text of chipTexts()) expect(text).not.toMatch(/\d/);

    await settle(() => second.resolve({ counts: counts(7), ok: true }));
    expect(await screen.findByRole('button', { name: `${toutes} (7)` })).toBeTruthy();
  });

  it('compteurs fournis avec la liste (rien de différé) : affichés tels quels', async () => {
    const known = placeholders.map((view) => ({ ...view, count: view.id === 'toutes' ? 12 : 3 }));
    await act(async () => {
      render(<OrdersWorkspace {...props({ views: known })} />);
    });
    expect(screen.getByRole('button', { name: `${toutes} (12)` })).toBeTruthy();
    expect(chips().getAttribute('data-counts-status')).toBe('ready');
  });
});
