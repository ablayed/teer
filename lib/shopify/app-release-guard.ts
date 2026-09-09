// APP-03 / Lot 2 correctif 3, §3 — décision de libération contrôlée d'une identité d'app Shopify.
//
// Symétrique de `decideShopAppSwitch` (lib/shopify/app-switch-guard.ts) : celle-ci REFUSE une
// bascule active→active ; celle-ci AUTORISE uniquement le passage uninstalled→libéré, jamais un
// raccourci vers active→active — les deux gardes se complètent, aucune ne remplace l'autre. Sans
// ce module, aucun chemin de code ne remet `shop.shopify_client_id`/`store_connection.platform_app_id`
// à NULL pour une boutique déjà possédée par une app (cf. rapport de diagnostic KOBA→Teer Public) :
// `decideShopAppSwitch` refuse tout rattachement d'une nouvelle app tant que l'ancienne identité
// reste posée, et rien ne l'efface après une désinstallation réelle.
//
// Module pur (aucun import Supabase/`env`/`'use server'`) pour rester unitairement et
// mutation-testable sans stack Supabase — même discipline que `app-switch-guard.ts`/
// `ownership-guard.ts`.
export type ReleasableShopSnapshot = {
  merchantAccountId: string;
  status: string;
  shopifyClientId: string | null;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
};

export type ReleasableConnectionSnapshot = {
  status: string;
  platformAppId: string | null;
} | null;

export type AppReleaseRefusalReason =
  | 'insufficient_role'
  | 'shop_not_found'
  | 'wrong_tenant'
  | 'shop_still_active'
  | 'credential_present'
  | 'no_app_to_release'
  | 'connection_missing'
  | 'connection_still_active'
  | 'connection_app_mismatch';

export type AppReleaseDecision =
  | { kind: 'ok' }
  | { kind: 'refuse'; reason: AppReleaseRefusalReason };

// Rôle exact requis — `owner` seulement, jamais `manager` (contrairement à `shop_update` RLS, qui
// autorise les deux) : la garde applicative est délibérément PLUS stricte que la policy RLS
// sous-jacente pour cette action précise, jamais l'inverse.
const REQUIRED_ROLE = 'owner';

// Préconditions cumulatives (§3.2 du mandat), TOUTES vérifiées avant tout accord — une seule
// suffit à refuser. `connection.platformAppId` peut être déjà NULL (reprise d'un état partiel
// après un échec intermédiaire, cf. app-release-write.ts) : c'est un état ACCEPTÉ, pas seulement
// `platformAppId === shop.shopifyClientId` — sinon une écriture de connexion réussie suivie d'un
// échec de l'écriture `shop` rendrait l'opération non rejouable (violerait l'exigence
// d'idempotence du mandat).
export function decideAppRelease(input: {
  requestingRole: string | null;
  requestingMerchantAccountId: string;
  shop: ReleasableShopSnapshot | null;
  connection: ReleasableConnectionSnapshot;
}): AppReleaseDecision {
  if (!input.shop) {
    return { kind: 'refuse', reason: 'shop_not_found' };
  }

  if (input.requestingRole !== REQUIRED_ROLE) {
    return { kind: 'refuse', reason: 'insufficient_role' };
  }

  if (input.shop.merchantAccountId !== input.requestingMerchantAccountId) {
    // Ne devrait jamais être atteint si l'appelant a déjà scopé sa lecture par tenant (RLS ou
    // filtre explicite) — gardé comme seconde barrière nommée, jamais une confiance implicite.
    return { kind: 'refuse', reason: 'wrong_tenant' };
  }

  if (input.shop.status !== 'uninstalled') {
    return { kind: 'refuse', reason: 'shop_still_active' };
  }

  if (input.shop.accessTokenEncrypted !== null || input.shop.refreshTokenEncrypted !== null) {
    return { kind: 'refuse', reason: 'credential_present' };
  }

  if (!input.shop.shopifyClientId) {
    return { kind: 'refuse', reason: 'no_app_to_release' };
  }

  if (!input.connection) {
    return { kind: 'refuse', reason: 'connection_missing' };
  }

  if (input.connection.status !== 'uninstalled') {
    return { kind: 'refuse', reason: 'connection_still_active' };
  }

  // Accepté si déjà libérée (reprise idempotente) OU si elle correspond encore à l'ancienne app.
  // Jamais accepté si elle pointe vers une AUTRE app que celle portée par `shop` — incohérence de
  // données, refusée plutôt que devinée.
  if (
    input.connection.platformAppId !== null &&
    input.connection.platformAppId !== input.shop.shopifyClientId
  ) {
    return { kind: 'refuse', reason: 'connection_app_mismatch' };
  }

  return { kind: 'ok' };
}
