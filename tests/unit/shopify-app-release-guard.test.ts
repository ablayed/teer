/**
 * APP-03 / Lot 2 correctif 3, §3-4 — couverture exhaustive de `decideAppRelease`
 * (lib/shopify/app-release-guard.ts), branche par branche, dans l'ordre où le module les évalue.
 *
 * Mutations manuelles vérifiées (rapportées dans le rapport de fin de lot, pas ici — chacune
 * restaurée après vérification) :
 * - retirer la condition de rôle → « manager : refusé » passe au vert à tort ;
 * - retirer la condition `status !== 'uninstalled'` → « boutique encore active : refusée » passe
 *   au vert à tort ;
 * - retirer la condition credential → « jeton présent : refusée » passe au vert à tort ;
 * - remplacer `platformAppId !== null && platformAppId !== shop.shopifyClientId` par une
 *   comparaison stricte `platformAppId !== shop.shopifyClientId` → « reprise idempotente (déjà
 *   libérée) » repasse au rouge (refuse alors qu'elle doit accepter) ;
 * - autoriser `active`→Teer Public directement (retirer la précondition `shop_still_active`) →
 *   « refuse toujours une bascule active→active » passe au vert à tort.
 */
import { type ReleasableShopSnapshot, decideAppRelease } from '@/lib/shopify/app-release-guard';
import { describe, expect, it } from 'vitest';

const BASE_SHOP: ReleasableShopSnapshot = {
  merchantAccountId: 'tenant-1',
  status: 'uninstalled',
  shopifyClientId: 'koba-client-id',
  accessTokenEncrypted: null,
  refreshTokenEncrypted: null,
};

const BASE_CONNECTION: { status: string; platformAppId: string | null } = {
  status: 'uninstalled',
  platformAppId: 'koba-client-id',
};

function decide(overrides: {
  requestingRole?: string | null;
  requestingMerchantAccountId?: string;
  shop?: Partial<ReleasableShopSnapshot> | null;
  connection?: Partial<typeof BASE_CONNECTION> | null;
}) {
  return decideAppRelease({
    // `?? 'owner'` traiterait un `requestingRole: null` explicite comme "non fourni" (`??` ne
    // distingue pas null d'absent) — `'requestingRole' in overrides` seul distingue les deux.
    requestingRole: 'requestingRole' in overrides ? (overrides.requestingRole ?? null) : 'owner',
    requestingMerchantAccountId: overrides.requestingMerchantAccountId ?? 'tenant-1',
    shop: overrides.shop === null ? null : { ...BASE_SHOP, ...(overrides.shop ?? {}) },
    connection:
      overrides.connection === null
        ? null
        : { ...BASE_CONNECTION, ...(overrides.connection ?? {}) },
  });
}

describe('decideAppRelease', () => {
  it('accepte owner + boutique désinstallée sans credential + connexion cohérente', () => {
    expect(decide({})).toEqual({ kind: 'ok' });
  });

  it("refuse quand la boutique n'a pas été trouvée (shop_not_found)", () => {
    expect(decide({ shop: null })).toEqual({ kind: 'refuse', reason: 'shop_not_found' });
  });

  it('manager : refusé (insufficient_role)', () => {
    expect(decide({ requestingRole: 'manager' })).toEqual({
      kind: 'refuse',
      reason: 'insufficient_role',
    });
  });

  it('agent : refusé (insufficient_role)', () => {
    expect(decide({ requestingRole: 'agent' })).toEqual({
      kind: 'refuse',
      reason: 'insufficient_role',
    });
  });

  it('non-membre (role null) : refusé (insufficient_role)', () => {
    expect(decide({ requestingRole: null })).toEqual({
      kind: 'refuse',
      reason: 'insufficient_role',
    });
  });

  it('autre tenant : refusé (wrong_tenant)', () => {
    expect(
      decide({
        requestingMerchantAccountId: 'tenant-2',
        shop: { merchantAccountId: 'tenant-1' },
      }),
    ).toEqual({ kind: 'refuse', reason: 'wrong_tenant' });
  });

  it('boutique encore active : refusée (shop_still_active) — jamais une bascule active→active', () => {
    expect(decide({ shop: { status: 'active' } })).toEqual({
      kind: 'refuse',
      reason: 'shop_still_active',
    });
  });

  it('access_token_encrypted présent : refusée (credential_present)', () => {
    expect(decide({ shop: { accessTokenEncrypted: 'still-there' } })).toEqual({
      kind: 'refuse',
      reason: 'credential_present',
    });
  });

  it('refresh_token_encrypted présent : refusée (credential_present)', () => {
    expect(decide({ shop: { refreshTokenEncrypted: 'still-there' } })).toEqual({
      kind: 'refuse',
      reason: 'credential_present',
    });
  });

  it('aucune app à libérer (shopifyClientId null) : refusée (no_app_to_release)', () => {
    expect(decide({ shop: { shopifyClientId: null } })).toEqual({
      kind: 'refuse',
      reason: 'no_app_to_release',
    });
  });

  it('connexion introuvable : refusée (connection_missing)', () => {
    expect(decide({ connection: null })).toEqual({ kind: 'refuse', reason: 'connection_missing' });
  });

  it('connexion encore active : refusée (connection_still_active)', () => {
    expect(decide({ connection: { status: 'active' } })).toEqual({
      kind: 'refuse',
      reason: 'connection_still_active',
    });
  });

  it('connexion pointant vers une AUTRE app que celle de shop : refusée (connection_app_mismatch)', () => {
    expect(decide({ connection: { platformAppId: 'une-autre-app' } })).toEqual({
      kind: 'refuse',
      reason: 'connection_app_mismatch',
    });
  });

  it('reprise idempotente — connexion déjà libérée (platformAppId null) : acceptée', () => {
    expect(decide({ connection: { platformAppId: null } })).toEqual({ kind: 'ok' });
  });
});
