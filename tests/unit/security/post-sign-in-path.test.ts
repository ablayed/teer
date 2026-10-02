import { postSignInPath } from '@/lib/security/post-sign-in-path';
import { describe, expect, it } from 'vitest';

describe('postSignInPath', () => {
  // SHOPIFY-OAUTH-FIRST-01 / D7 — l'ancienne reprise non embarquée n'existe plus.
  it('n’exempte plus /shopify/install-entry (supprimé par D7)', () => {
    expect(postSignInPath('/shopify/install-entry')).toBe('/s?next=%2Fshopify%2Finstall-entry');
  });

  // SHOPIFY-OAUTH-FIRST-01 / T36 — garde mutée : `target === SHOPIFY_SHOPS_ARRIVAL_PATH`.
  it('T36 : reprend exactement /parametres?tab=shops, et aucune variante', () => {
    expect(postSignInPath('/parametres?tab=shops')).toBe('/parametres?tab=shops');
    expect(postSignInPath('/parametres?tab=shops&connected=1')).toBe(
      '/s?next=%2Fparametres%3Ftab%3Dshops%26connected%3D1',
    );
    expect(postSignInPath('/parametres?tab=team')).toBe('/s?next=%2Fparametres%3Ftab%3Dteam');
    expect(postSignInPath('/parametres')).toBe('/s?next=%2Fparametres');
  });

  // SHOPIFY-OAUTH-FIRST-01 / B3 — garde mutée : `target === SHOPIFY_CLAIM_PATH`.
  it('reprend exactement /shopify/claim, et aucune variante', () => {
    expect(postSignInPath('/shopify/claim')).toBe('/shopify/claim');
    expect(postSignInPath('/shopify/claim?ticket=forged')).toBe(
      '/s?next=%2Fshopify%2Fclaim%3Fticket%3Dforged',
    );
    expect(postSignInPath('/shopify/claims')).toBe('/s?next=%2Fshopify%2Fclaims');
  });

  it('enveloppe toute cible interne ordinaire dans /s?next=...', () => {
    expect(postSignInPath('/tableau')).toBe('/s?next=%2Ftableau');
  });

  it('retombe sur /s (via safeRedirectPath → /tableau) quand redirectTo est absent', () => {
    expect(postSignInPath(undefined)).toBe('/s?next=%2Ftableau');
  });

  it('laisse passer /s et ses variantes sans enveloppe', () => {
    expect(postSignInPath('/s')).toBe('/s');
    expect(postSignInPath('/s/store-id')).toBe('/s/store-id');
    expect(postSignInPath('/s?next=%2Ftableau')).toBe('/s?next=%2Ftableau');
  });

  it('laisse passer /shopify/embedded-link avec sa continuation, sans passer par le sélecteur', () => {
    expect(postSignInPath('/shopify/embedded-link?intent=abc.def')).toBe(
      '/shopify/embedded-link?intent=abc.def',
    );
    expect(postSignInPath('/shopify/embedded-link')).toBe('/shopify/embedded-link');
  });

  it('n’exempte PAS un autre chemin sous /shopify/ — seul le préfixe exact est allowlisté', () => {
    expect(postSignInPath('/shopify/embedded')).toBe('/s?next=%2Fshopify%2Fembedded');
    expect(postSignInPath('/shopify/embedded-link-evil')).toBe(
      '/s?next=%2Fshopify%2Fembedded-link-evil',
    );
  });
});
