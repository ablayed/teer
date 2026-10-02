// @vitest-environment jsdom
//
// SHOPIFY-OAUTH-FIRST-01 / B3 — GET /shopify/claim, décision de la page (lecture seule) et
// reprise après onboarding (D5, T11).
//
// Couche : unitaire. `loadShopifyClaimView` est exercée telle quelle avec des lectures injectées ;
// la lecture réelle de l'attente et l'absence de mutation contre la base (T15) sont prouvées dans
// tests/rls/shopify-oauth-first-01.rls.test.ts.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  push: vi.fn(),
  merchantAccount: null as { onboarded_at: string | null } | null,
  completeResult: null as unknown,
}));

vi.mock('next/navigation', () => ({
  redirect: harness.redirect,
  useRouter: () => ({ push: harness.push }),
}));
vi.mock('@/lib/actions/merchant', () => ({
  getMerchantAccount: async () => harness.merchantAccount,
  completeOnboardingAction: 'complete-onboarding',
}));
vi.mock('@/lib/legal/consent', () => ({
  getMissingCurrentConsents: async () => ({ ok: true, documents: [] }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
  }),
}));
vi.mock('next-safe-action/hooks', () => ({
  useAction: () => ({ execute: vi.fn(), result: { data: harness.completeResult } }),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

type Deps = Parameters<typeof import('@/lib/shopify/claim-view').loadShopifyClaimView>[0];

function deps(overrides: Partial<Deps> = {}): Deps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    readPending: async () => {
      calls.push('readPending');
      return { state: 'valid', shopDomain: 'claim-shop.myshopify.com', clientId: 'app-1' };
    },
    getUserId: async () => {
      calls.push('getUserId');
      return 'user-1';
    },
    getMembership: async () => {
      calls.push('getMembership');
      return { merchantAccountId: 'account-1', role: 'owner' };
    },
    getAccountName: async () => {
      calls.push('getAccountName');
      return 'Espace Test';
    },
    ...overrides,
  };
}

async function load(input: Deps) {
  const { loadShopifyClaimView } = await import('@/lib/shopify/claim-view');
  return loadShopifyClaimView(input);
}

beforeEach(() => {
  harness.redirect.mockClear();
  harness.push.mockClear();
  harness.merchantAccount = null;
  harness.completeResult = null;
});

afterEach(() => cleanup());

describe('B3 — décision de GET /shopify/claim', () => {
  it('confirmation : domaine myshopify et nom de l’espace, pour owner et manager', async () => {
    expect(await load(deps())).toEqual({
      kind: 'confirm',
      shopDomain: 'claim-shop.myshopify.com',
      accountName: 'Espace Test',
    });
    expect(
      await load(
        deps({ getMembership: async () => ({ merchantAccountId: 'account-1', role: 'manager' }) }),
      ),
    ).toMatchObject({ kind: 'confirm' });
  });

  it('ticket inconnu, consommé ou expiré → message de reprise, sans exiger de session', async () => {
    const input = deps({ readPending: async () => ({ state: 'invalid' }) });
    expect(await load(input)).toEqual({ kind: 'ticket_invalid' });
    expect(input.calls).not.toContain('getUserId');
  });

  it('sans session → connexion avec /shopify/claim pour seule reprise', async () => {
    expect(await load(deps({ getUserId: async () => null }))).toEqual({
      kind: 'redirect',
      to: '/connexion?redirectTo=%2Fshopify%2Fclaim',
    });
  });

  it('T11 : session sans espace → onboarding, reprise préservée', async () => {
    expect(await load(deps({ getMembership: async () => null }))).toEqual({
      kind: 'redirect',
      to: '/onboarding?redirectTo=%2Fshopify%2Fclaim',
    });
  });

  it('rôle agent → refus nommé, sans confirmation (D4)', async () => {
    const input = deps({
      getMembership: async () => ({ merchantAccountId: 'account-1', role: 'agent' }),
    });
    expect(await load(input)).toEqual({ kind: 'forbidden' });
    expect(input.calls).not.toContain('getAccountName');
  });

  it('lecture en erreur → état d’erreur, jamais un ticket « invalide » ni une confirmation', async () => {
    expect(await load(deps({ readPending: async () => ({ state: 'error' }) }))).toEqual({
      kind: 'error',
    });
    expect(await load(deps({ getMembership: async () => 'error' }))).toEqual({ kind: 'error' });
  });

  it('un ticket de forme invalide n’atteint pas la base', async () => {
    const { readShopifyPendingInstallation } = await import('@/lib/shopify/claim-view');
    const rpc = vi.fn();
    for (const ticket of [undefined, '', 'court', `${'a'.repeat(43)}!`]) {
      expect(await readShopifyPendingInstallation({ rpc } as never, ticket)).toEqual({
        state: 'invalid',
      });
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('T11 — reprise après l’onboarding (D5)', () => {
  it('shopifyClaimResumePath n’accepte que /shopify/claim exact', async () => {
    const { shopifyClaimResumePath } = await import('@/lib/shopify/claim-ticket');
    expect(shopifyClaimResumePath('/shopify/claim')).toBe('/shopify/claim');
    for (const value of ['/shopify/claim?x=1', '/tableau', '//evil.example', undefined, null]) {
      expect(shopifyClaimResumePath(value)).toBeNull();
    }
  });

  it('espace déjà onboardé : /onboarding?redirectTo=/shopify/claim reprend le rattachement', async () => {
    harness.merchantAccount = { onboarded_at: '2026-09-01T00:00:00Z' };
    const { default: OnboardingPage } = await import('@/app/onboarding/page');
    await expect(
      OnboardingPage({ searchParams: Promise.resolve({ redirectTo: '/shopify/claim' }) }),
    ).rejects.toThrow('REDIRECT:/shopify/claim');
    await expect(
      OnboardingPage({ searchParams: Promise.resolve({ redirectTo: '/ailleurs' }) }),
    ).rejects.toThrow('REDIRECT:/tableau');
  });

  it('onboarding terminé : le bouton final reprend /shopify/claim', async () => {
    harness.completeResult = { ok: true };
    const { OnboardingFlow } = await import('@/components/onboarding/onboarding-flow');
    render(<OnboardingFlow resumeTo="/shopify/claim" />);
    fireEvent.click(await screen.findByRole('button', { name: 'welcome.cta' }));
    expect(harness.push).toHaveBeenCalledWith('/shopify/claim');
  });

  it('contrôle positif : sans reprise, le bouton final garde /tableau', async () => {
    harness.completeResult = { ok: true };
    const { OnboardingFlow } = await import('@/components/onboarding/onboarding-flow');
    render(<OnboardingFlow />);
    fireEvent.click(await screen.findByRole('button', { name: 'welcome.cta' }));
    expect(harness.push).toHaveBeenCalledWith('/tableau');
  });
});
