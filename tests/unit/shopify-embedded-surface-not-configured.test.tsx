// @vitest-environment jsdom

// APP-03 / Lot 2 (correctif) — quand host est absent/invalide pour Teer Public, l'interface ne
// doit JAMAIS retomber sur le lien legacy /api/shopify/embedded/install (le parcours que ce lot
// retire précisément pour cette app). Le test assert l'ABSENCE du lien de repli à l'écran, pas
// seulement l'absence de loginUrl dans la réponse serveur.
import { EmbeddedShopifySurface } from '@/app/shopify/embedded/embedded-shopify-surface';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'shopify');
});

function stubBridgeAndFetch(responseBody: unknown) {
  (window as unknown as { shopify: { idToken: () => Promise<string> } }).shopify = {
    idToken: async () => 'fresh-id-token',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200 })),
  );
}

const VALID_HOST = Buffer.from('admin.shopify.com/store/acme-shop', 'utf8').toString('base64url');

describe('EmbeddedShopifySurface — not_configured, jamais de lien legacy pour Teer Public sans loginUrl', () => {
  beforeEach(() => {
    cleanup();
  });

  it('n’affiche AUCUN lien vers /api/shopify/embedded/install quand Teer Public n’a pas de loginUrl (host absent)', async () => {
    stubBridgeAndFetch({
      status: 'not_configured',
      shop: { domain: 'acme-shop.myshopify.com' },
      nextAction: 'associate_teer',
      appLabel: 'teer-public',
    });

    render(
      <EmbeddedShopifySurface
        clientId="public-client-sentinel"
        host={VALID_HOST}
        supportEmail="support@teer.example"
        appLabel="teer-public"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('shopify-embedded-state').getAttribute('data-state')).toBe(
        'not_configured_closed',
      );
    });

    expect(screen.queryByText('Associer Tëër et installer')).toBeNull();
    expect(document.querySelector('a[href^="/api/shopify/embedded/install"]')).toBeNull();
  });

  it('affiche le bouton top-level (jamais le lien legacy) quand Teer Public a une loginUrl', async () => {
    stubBridgeAndFetch({
      status: 'not_configured',
      shop: { domain: 'acme-shop.myshopify.com' },
      nextAction: 'associate_teer',
      appLabel: 'teer-public',
      loginUrl: '/connexion?redirectTo=%2Fshopify%2Fembedded-link%3Fintent%3Dabc',
    });

    render(
      <EmbeddedShopifySurface
        clientId="public-client-sentinel"
        host={VALID_HOST}
        supportEmail="support@teer.example"
        appLabel="teer-public"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('Associer Tëër et installer')).not.toBeNull();
    });

    expect(screen.getByText('Associer Tëër et installer').tagName).toBe('BUTTON');
    expect(document.querySelector('a[href^="/api/shopify/embedded/install"]')).toBeNull();
  });

  it('conserve le lien legacy pour une app historique sans loginUrl (comportement inchangé)', async () => {
    stubBridgeAndFetch({
      status: 'not_configured',
      shop: { domain: 'acme-shop.myshopify.com' },
      nextAction: 'associate_teer',
      appLabel: 'teer-dev',
    });

    render(
      <EmbeddedShopifySurface
        clientId="dev-client-sentinel"
        host={VALID_HOST}
        supportEmail="support@teer.example"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('Associer Tëër et installer')).not.toBeNull();
    });

    const link = screen.getByText('Associer Tëër et installer').closest('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toContain('/api/shopify/embedded/install');
  });
});
