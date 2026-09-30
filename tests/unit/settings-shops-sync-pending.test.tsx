// @vitest-environment jsdom
//
// SHOPIFY-OAUTH-FIRST-01 / R2, T37 — une connexion réussie dont un effet après persistance a
// échoué arrive sur /parametres?tab=shops&connected=1&sync=pending : la page dit que la
// synchronisation est en attente et peut être relancée, SANS aucune bannière d'échec.
import { SettingsShops } from '@/components/settings/settings-shops';
import messages from '@/messages/fr.json';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ query: {} as Record<string, string | null> }));

vi.mock('nuqs', () => ({
  useQueryState: (key: string) => [harness.query[key] ?? null, vi.fn()],
}));
vi.mock('@/lib/actions/shops', () => ({
  listShopsAction: 'list',
  syncShopAction: 'sync',
  disconnectShopAction: 'disconnect',
  releaseShopAppAction: 'release',
}));
vi.mock('@/components/settings/woocommerce-connections', () => ({
  WooCommerceConnections: () => null,
}));
vi.mock('next-safe-action/hooks', () => ({
  useAction: () => ({
    execute: vi.fn(),
    executeAsync: vi.fn(),
    isExecuting: false,
    status: 'idle',
    result: { data: { ok: true, currentRole: 'owner', shops: [] } },
  }),
}));

function renderShops() {
  return render(
    <NextIntlClientProvider locale="fr" messages={messages}>
      <SettingsShops currentRole="owner" />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  harness.query = {};
});
afterEach(() => cleanup());

describe('T37 — arrivée avec sync=pending', () => {
  it('annonce la synchronisation en attente, sans bannière d’échec', () => {
    harness.query = { connected: '1', sync: 'pending' };
    renderShops();
    expect(screen.getByText(messages.settings.shops.messages.syncPending)).toBeTruthy();
    expect(screen.getByText(messages.settings.shops.messages.connected)).toBeTruthy();
    expect(screen.queryByText(messages.settings.shops.errors.connection_failed)).toBeNull();
    expect(screen.queryByText(messages.settings.shops.errors.generic)).toBeNull();
  });

  it('contrôle positif : sans sync=pending, aucun bandeau d’attente', () => {
    harness.query = { connected: '1' };
    renderShops();
    expect(screen.queryByText(messages.settings.shops.messages.syncPending)).toBeNull();
  });
});
