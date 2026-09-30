// @vitest-environment jsdom
//
// SHOPIFY-OAUTH-FIRST-01 / B11 — surface d'erreur publique D15 (T26 : aucune fuite).
// Couche : unitaire, page réelle rendue.
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ publicEnv: { NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.com' } }));

async function renderError(code: string | string[] | undefined) {
  const { default: Page } = await import('@/app/shopify/erreur/page');
  const element = await Page({ searchParams: Promise.resolve({ code }) });
  return render(element);
}

afterEach(() => cleanup());

describe('B11 — /shopify/erreur?code=', () => {
  it('chaque code de l’énumération fermée a un message fixe', async () => {
    const { SHOPIFY_PUBLIC_ERROR_CODES, SHOPIFY_PUBLIC_ERROR_MESSAGES } = await import(
      '@/lib/shopify/public-error'
    );
    expect(SHOPIFY_PUBLIC_ERROR_CODES).toEqual([
      'invalid_request',
      'other_app',
      'credentials_unavailable',
      'connection_in_progress',
      'ticket_invalid',
      'refused',
      'forbidden',
      'unknown',
    ]);
    for (const code of SHOPIFY_PUBLIC_ERROR_CODES) {
      const { container } = await renderError(code);
      expect(container.querySelector('main')?.getAttribute('data-error')).toBe(code);
      expect(container.textContent).toContain(SHOPIFY_PUBLIC_ERROR_MESSAGES[code].title);
      cleanup();
    }
  });

  it('code inconnu, multiple ou absent → unknown ; rien de la requête n’est réfléchi', async () => {
    for (const code of [
      '<script>alert(1)</script>',
      'victime.myshopify.com',
      ['refused', 'x'],
      undefined,
    ]) {
      const { container } = await renderError(code);
      expect(container.querySelector('main')?.getAttribute('data-error')).toBe('unknown');
      expect(container.innerHTML).not.toContain('<script>');
      expect(container.textContent).not.toContain('victime.myshopify.com');
      cleanup();
    }
  });

  it('refused reste neutre et oriente vers le support ; other_app oriente vers le support', async () => {
    const refused = await renderError('refused');
    expect(refused.container.textContent).not.toMatch(/autre (compte|espace|locataire)/);
    expect(refused.container.textContent).toContain('support@example.com');
    cleanup();
    const otherApp = await renderError('other_app');
    expect(otherApp.container.textContent).toContain('support@example.com');
  });
});
