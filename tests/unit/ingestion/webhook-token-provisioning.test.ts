// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C1 — choix du mode de rotation du jeton L3.
//
// Couche : unitaire, fonction pure. Les écritures elles-mêmes (grâce, compare-and-set,
// `revoked_at`) sont prouvées contre PostgREST réel dans
// tests/rls/shopify-webhooks-1b-token.rls.test.ts.
import { resolveRotationMode } from '@/lib/ingestion/webhook-token-provisioning';
import { describe, expect, it } from 'vitest';

const EMPTY = { hasPrevious: false, hasForeignOnOurOrigin: false };

describe('resolveRotationMode — le mode ne se déduit jamais de la seule absence d’abonnement courant', () => {
  it('finalisation avec inventaire vide → installation, sans grâce', () => {
    expect(resolveRotationMode('installation', EMPTY)).toBe('installation');
  });

  it('finalisation avec un abonnement sur l’empreinte précédente → réparation, avec grâce', () => {
    expect(resolveRotationMode('installation', { ...EMPTY, hasPrevious: true })).toBe('repair');
  });

  it('finalisation avec un abonnement non reconnu vers notre origine → réparation, avec grâce', () => {
    expect(resolveRotationMode('installation', { ...EMPTY, hasForeignOnOurOrigin: true })).toBe(
      'repair',
    );
  });

  it('réparation → toujours avec grâce, quel que soit l’inventaire', () => {
    expect(resolveRotationMode('repair', EMPTY)).toBe('repair');
    expect(resolveRotationMode('repair', { hasPrevious: true, hasForeignOnOurOrigin: true })).toBe(
      'repair',
    );
  });
});
