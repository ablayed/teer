// @vitest-environment jsdom
import { join } from 'node:path';
import { compactMenuHasItems, menuTransitionEntries } from '@/lib/domain/order-menu-actions';
import { repoRoot, staticReachableFrom } from '@/tests/helpers/static-imports';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ComponentType, Suspense, lazy } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Menu « Actions » à la demande (V4) : un bouton par carte, le menu complet monté au premier appui
// pour une seule carte, gardé tant que sa transition est en cours, son code jamais dans le chemin
// initial de /commandes.

const state = vi.hoisted(() => ({
  loads: 0,
  busyReporters: new Map<string, (busy: boolean) => void>(),
}));

vi.mock('next/dynamic', () => ({
  default: (loader: () => Promise<ComponentType<Record<string, unknown>>>) => {
    const Lazy = lazy(async () => ({ default: await loader() }));
    return (props: Record<string, unknown>) => (
      <Suspense fallback={null}>
        <Lazy {...props} />
      </Suspense>
    );
  },
}));

vi.mock('@/components/orders/order-actions-menu', () => {
  state.loads += 1;
  return {
    OrderActionsMenu: (props: {
      compact?: boolean;
      defaultOpen?: boolean;
      onBusyChange?: (busy: boolean) => void;
      orderId: string;
    }) => {
      if (props.onBusyChange) state.busyReporters.set(props.orderId, props.onBusyChange);
      return (
        <div
          data-compact={String(props.compact)}
          data-open={String(props.defaultOpen)}
          data-testid={`menu-${props.orderId}`}
        />
      );
    },
  };
});

import { LazyOrderActions, useActiveOrderMenu } from '@/components/orders/lazy-order-actions';

function Host({ withActions = ['assigner'] as const }: { withActions?: readonly string[] }) {
  const menu = useActiveOrderMenu();
  return (
    <>
      {['a', 'b'].map((id) => (
        <LazyOrderActions
          allowedActions={[...withActions] as never}
          deliveryState={null}
          drivers={[]}
          key={id}
          label={`Actions ${id}`}
          mounted={menu.isMounted(id)}
          onActivate={() => menu.activate(id)}
          onBusyChange={(busy) => menu.setBusy(id, busy)}
          orderId={id}
          orderState="open"
          phone={null}
          whatsappOrderData={{} as never}
        />
      ))}
    </>
  );
}

describe('menu Actions à la demande', () => {
  beforeEach(() => {
    state.busyReporters.clear();
  });
  afterEach(cleanup);

  it('une carte sans entrée de menu n’a pas de bouton', () => {
    render(<Host withActions={[]} />);
    expect(screen.queryAllByTestId('order-actions-trigger')).toHaveLength(0);
  });

  it('au départ : un bouton par carte, aucun menu monté', () => {
    render(<Host />);
    expect(screen.getAllByTestId('order-actions-trigger')).toHaveLength(2);
    expect(screen.queryByTestId('menu-a')).toBeNull();
    expect(screen.queryByTestId('menu-b')).toBeNull();
  });

  it('un appui monte le menu de CETTE carte, compact et ouvert', async () => {
    render(<Host />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Actions a'));
    });
    const menu = await screen.findByTestId('menu-a');
    expect(menu.getAttribute('data-compact')).toBe('true');
    expect(menu.getAttribute('data-open')).toBe('true');
    expect(screen.queryByTestId('menu-b')).toBeNull();
    // Le bouton de la carte b reste un simple bouton.
    expect(screen.getAllByTestId('order-actions-trigger')).toHaveLength(1);
  });

  it('un seul menu actif : appuyer sur une autre carte démonte le premier', async () => {
    render(<Host />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Actions a'));
    });
    await screen.findByTestId('menu-a');
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Actions b'));
    });
    await screen.findByTestId('menu-b');
    expect(screen.queryByTestId('menu-a')).toBeNull();
  });

  it('une transition en cours garde son menu monté, jusqu’à sa fin', async () => {
    render(<Host />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Actions a'));
    });
    await screen.findByTestId('menu-a');
    act(() => state.busyReporters.get('a')?.(true));
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Actions b'));
    });
    await screen.findByTestId('menu-b');
    expect(screen.queryByTestId('menu-a')).not.toBeNull();

    act(() => state.busyReporters.get('a')?.(false));
    expect(screen.queryByTestId('menu-a')).toBeNull();
  });

  it('le code du menu n’est téléchargé qu’à l’approche du doigt ou du pointeur, pas au rendu', async () => {
    vi.resetModules();
    const factoryRuns = vi.fn();
    vi.doMock('@/components/orders/order-actions-menu', () => {
      factoryRuns();
      return { OrderActionsMenu: () => null };
    });
    const { LazyOrderActions: Fresh } = await import('@/components/orders/lazy-order-actions');
    render(
      <Fresh
        allowedActions={['assigner']}
        deliveryState={null}
        drivers={[]}
        label="Actions z"
        mounted={false}
        onActivate={() => undefined}
        onBusyChange={() => undefined}
        orderId="z"
        orderState="open"
        phone={null}
        whatsappOrderData={{} as never}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(factoryRuns).not.toHaveBeenCalled();

    fireEvent.pointerEnter(screen.getByLabelText('Actions z'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(factoryRuns).toHaveBeenCalledTimes(1);
  });
});

describe('modèle du menu', () => {
  it('« démarrer la livraison » et « refuser » ne font jamais une entrée', () => {
    expect(menuTransitionEntries(['demarrer_livraison'])).toEqual([]);
    expect(menuTransitionEntries(['refuser'])).toEqual([]);
  });

  it('« programmer » masque « confirmer »', () => {
    expect(menuTransitionEntries(['confirmer', 'programmer'])).toEqual(['programmer']);
    expect(menuTransitionEntries(['confirmer'])).toEqual(['confirmer']);
  });

  it('l’ordre d’affichage est celui du modèle', () => {
    expect(menuTransitionEntries(['livrer', 'annuler', 'assigner'])).toEqual([
      'annuler',
      'assigner',
      'livrer',
    ]);
  });

  it('compact : un menu s’il y a une entrée OU un numéro', () => {
    expect(compactMenuHasItems([], null)).toBe(false);
    expect(compactMenuHasItems(['demarrer_livraison'], null)).toBe(false);
    expect(compactMenuHasItems([], '+221770000000')).toBe(true);
    expect(compactMenuHasItems(['annuler'], null)).toBe(true);
  });
});

describe('chemin initial de /commandes', () => {
  it('n’importe statiquement ni le menu complet, ni les dialogues, ni la feuille WhatsApp', () => {
    const root = repoRoot();
    const reachable = [...staticReachableFrom(join(root, 'app/(app)/commandes/page.tsx'))].map(
      (file) => file.replace(root, '').split('\\').join('/'),
    );
    for (const heavy of [
      '/components/orders/order-actions-menu.tsx',
      '/components/orders/transition-dialog.tsx',
      '/components/orders/assignment-details-dialog.tsx',
      '/components/whatsapp/whatsapp-compose-sheet.tsx',
    ]) {
      expect(reachable, heavy).not.toContain(heavy);
    }
  });

  it('le menu complet n’est atteint que par import dynamique depuis le chargeur', () => {
    const root = repoRoot();
    const reachable = [
      ...staticReachableFrom(join(root, 'components/orders/lazy-order-actions.tsx')),
    ].map((file) => file.replace(root, '').split('\\').join('/'));
    expect(reachable).not.toContain('/components/orders/order-actions-menu.tsx');
  });

  it('le menu complet charge ses dialogues et la feuille WhatsApp à la demande', () => {
    const root = repoRoot();
    const reachable = [
      ...staticReachableFrom(join(root, 'components/orders/order-actions-menu.tsx')),
    ].map((file) => file.replace(root, '').split('\\').join('/'));
    for (const heavy of [
      '/components/orders/transition-dialog.tsx',
      '/components/orders/assignment-details-dialog.tsx',
      '/components/whatsapp/whatsapp-compose-sheet.tsx',
    ]) {
      expect(reachable, heavy).not.toContain(heavy);
    }
  });
});
