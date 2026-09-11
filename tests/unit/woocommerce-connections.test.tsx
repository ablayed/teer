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
        isExecuting: false,
        result: { data: harness.listResult },
      };
    }
    if (action === 'create-action') {
      return {
        executeAsync: harness.createExecuteAsync,
        isExecuting: false,
        result: { data: null },
      };
    }
    return {
      executeAsync: harness.completeExecuteAsync,
      isExecuting: false,
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

afterEach(() => cleanup());

describe('état visible des connexions WooCommerce', () => {
  beforeEach(() => {
    harness.listExecute.mockReset();
    harness.createExecuteAsync.mockReset();
    harness.completeExecuteAsync.mockReset();
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
