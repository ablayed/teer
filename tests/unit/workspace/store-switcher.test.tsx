// @vitest-environment jsdom

import { StoreSwitcher } from '@/components/workspace/store-switcher';
import type { WorkspaceStore } from '@/lib/workspace/store';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({
  pathname: '/s/00000000-0000-4000-8000-000000000001/tableau',
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

const storeMain: WorkspaceStore = {
  displayName: 'Boutique principale',
  id: '00000000-0000-4000-8000-000000000001',
  isDefault: true,
  merchantAccountId: 'merchant-1',
  role: 'owner',
  shopDomain: 'main.example.test',
  status: 'active',
  storeKind: 'manual',
};

const storeA: WorkspaceStore = {
  ...storeMain,
  displayName: 'Boutique A',
  id: '00000000-0000-4000-8000-000000000002',
  isDefault: false,
  shopDomain: 'a.example.test',
};

describe('StoreSwitcher', () => {
  afterEach(() => {
    cleanup();
    navigation.pathname = '/s/00000000-0000-4000-8000-000000000001/tableau';
  });

  it('follows the URL when a shared layout still holds the earlier default-store response', () => {
    const stores = [storeMain, storeA];
    const { rerender } = render(<StoreSwitcher currentStore={storeMain} stores={stores} />);

    expect(screen.getByTestId('store-switcher-name').textContent).toBe('Boutique principale');

    // Deterministic response order: the streamed layout payload for the default
    // store resolved first. The browser then navigates to A while that shared
    // layout still carries the older currentStore prop.
    navigation.pathname = '/s/00000000-0000-4000-8000-000000000002/tableau';
    rerender(<StoreSwitcher currentStore={storeMain} stores={stores} />);

    expect(screen.getByTestId('store-switcher-name').textContent).toBe('Boutique A');

    fireEvent.click(screen.getByRole('button', { name: /Changer/ }));
    expect(screen.getByRole('menuitem', { name: 'Boutique A' }).getAttribute('aria-current')).toBe(
      'true',
    );
    expect(
      screen.getByRole('menuitem', { name: 'Boutique principale' }).getAttribute('aria-current'),
    ).toBeNull();
  });
});
