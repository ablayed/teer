import { postSignInPath } from '@/lib/security/post-sign-in-path';
import { describe, expect, it } from 'vitest';

describe('postSignInPath', () => {
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
