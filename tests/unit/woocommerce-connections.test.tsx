// @vitest-environment jsdom

import { WooCommerceConnections } from '@/components/settings/woocommerce-connections';
import messages from '@/messages/fr.json';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  listExecute: vi.fn(),
  createExecuteAsync: vi.fn(),
  completeExecuteAsync: vi.fn(),
  listResult: null as unknown,
  listIsExecuting: false,
  listHasErrored: false,
}));

vi.mock('@/lib/actions/woocommerce', () => ({
  listWooCommerceConnectionsAction: 'list-action',
  createWooCommerceConnectionIntentAction: 'create-action',
  completeWooCommerceConnectionAction: 'complete-action',
}));

vi.mock('next-safe-action/hooks', () => ({
  useAction: (action: string) => {
    if (action === 'list-action') {
      return {
        execute: harness.listExecute,
        isExecuting: harness.listIsExecuting,
        hasErrored: harness.listHasErrored,
        result: { data: harness.listResult },
      };
    }
    if (action === 'create-action') {
      return {
        executeAsync: harness.createExecuteAsync,
        isExecuting: false,
        hasErrored: false,
        result: { data: null },
      };
    }
    return {
      executeAsync: harness.completeExecuteAsync,
      isExecuting: false,
      hasErrored: false,
      result: { data: null },
    };
  },
}));

const shopId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function renderConnections(connection: Record<string, unknown>) {
  harness.listResult = {
    ok: true,
    shops: [{ id: shopId, displayName: 'Boutique test', domain: 'https://store.example.test' }],
    connections: [connection],
  };
  return render(
    <NextIntlClientProvider locale="fr" messages={messages}>
      <WooCommerceConnections currentRole="owner" />
    </NextIntlClientProvider>,
  );
}

function renderEmptyConnections() {
  harness.listResult = { ok: true, canCreateNewShop: true, shops: [], connections: [] };
  return render(
    <NextIntlClientProvider locale="fr" messages={messages}>
      <WooCommerceConnections currentRole="owner" />
    </NextIntlClientProvider>,
  );
}

function renderWithListState(state: {
  result?: unknown;
  isExecuting?: boolean;
  hasErrored?: boolean;
}) {
  harness.listResult = state.result ?? null;
  harness.listIsExecuting = state.isExecuting ?? false;
  harness.listHasErrored = state.hasErrored ?? false;
  return render(
    <NextIntlClientProvider locale="fr" messages={messages}>
      <WooCommerceConnections currentRole="owner" />
    </NextIntlClientProvider>,
  );
}

afterEach(() => cleanup());

describe('état visible des connexions WooCommerce', () => {
  beforeEach(() => {
    harness.listExecute.mockReset();
    harness.createExecuteAsync.mockReset();
    harness.completeExecuteAsync.mockReset();
    harness.listIsExecuting = false;
    harness.listHasErrored = false;
  });

  // Ce test prouve UNIQUEMENT la traduction `canCreateNewShop: true` → formulaire. Il ne prouve
  // rien du chemin applicatif : l'action y est entièrement remplacée. La preuve que l'action
  // produit réellement cet état est dans tests/rls/r2-woocommerce-connections-list.rls.test.ts.
  it('propose la première connexion sans sélection de boutique et masque le domaine synthétique', () => {
    renderEmptyConnections();

    expect(screen.getByLabelText('URL de la boutique')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connecter WooCommerce' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('woocommerce-');
    expect(document.body.textContent).not.toContain('.internal');
  });

  it('rend un échec de lecture comme une erreur, jamais comme l’état vide', () => {
    renderWithListState({ result: { ok: false, errorCode: 'list_failed' } });

    expect(
      screen.getByText(
        'Vos connexions WooCommerce n’ont pas pu être chargées. Réessayez dans quelques instants.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeTruthy();
    // La microcopie de l'état vide ne doit jamais servir à dire « la lecture a échoué ».
    expect(screen.queryByText('Aucune boutique WooCommerce connectée.')).toBeNull();
    expect(screen.queryByLabelText('URL de la boutique')).toBeNull();
  });

  it('rend une erreur serveur opaque comme une erreur, jamais comme l’état vide', () => {
    renderWithListState({ hasErrored: true });

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Aucune boutique WooCommerce connectée.')).toBeNull();
    expect(screen.queryByText('Chargement des connexions WooCommerce…')).toBeNull();
  });

  it('affiche un chargement explicite avant le retour de l’action', () => {
    renderWithListState({ isExecuting: true });

    expect(screen.getByRole('status').textContent).toBe('Chargement des connexions WooCommerce…');
    expect(screen.queryByText('Aucune boutique WooCommerce connectée.')).toBeNull();
    expect(screen.queryByLabelText('URL de la boutique')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('affiche l’état vide seulement sur un succès réellement vide', () => {
    renderWithListState({
      result: { ok: true, canCreateNewShop: false, shops: [], connections: [] },
    });

    expect(screen.getByText('Aucune boutique WooCommerce connectée.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('affiche opérationnelle seulement quand les deux abonnements sont actifs', () => {
    renderConnections({
      id: connectionId,
      shopId,
      shopName: 'Boutique test',
      shopDomain: 'https://store.example.test',
      externalIdentifier: 'https://store.example.test',
      status: 'active',
      subscriptions: { 'order.created': 'active', 'order.updated': 'active' },
      syncStatus: 'completed',
      syncLastErrorCode: null,
      syncLastPageObserved: 1,
      syncUpdatedAt: '2026-09-11T10:00:00.000Z',
    });

    expect(screen.getByText('Opérationnelle')).toBeTruthy();
    expect(screen.getByText('Synchronisation initiale terminée.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reprendre' })).toBeNull();
  });

  it('expose la reprise d’un provisionnement ou d’un scan échoué et verrouille l’URL existante', () => {
    renderConnections({
      id: connectionId,
      shopId,
      shopName: 'Boutique test',
      shopDomain: 'https://store.example.test',
      externalIdentifier: 'https://store.example.test',
      status: 'provisioning',
      subscriptions: { 'order.created': 'active' },
      syncStatus: 'failed',
      syncLastErrorCode: 'sync_total_changed',
      syncLastPageObserved: 2,
      syncUpdatedAt: '2026-09-11T10:00:00.000Z',
    });

    expect(screen.getByText('Provisionnement en cours')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reprendre' })).toBeTruthy();
    expect(screen.getByLabelText('URL de la boutique')).toHaveProperty('disabled', true);
  });
});
