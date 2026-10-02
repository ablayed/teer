// SHOPIFY-OAUTH-FIRST-01 / R1 — arrivée d'une boutique déjà installée (entrée `installed_valid`
// ou `installed_refreshable`, branche 1 du callback, consommation d'un ticket).
//
// Avec une session : la surface des boutiques. La RLS n'y montre la boutique qu'à son locataire ;
// AUCUNE association automatique n'a lieu pour un utilisateur connecté à un autre locataire.
// Sans session : la connexion, avec pour seule reprise ce chemin exact (`postSignInPath` n'en
// accepte pas d'autre, lib/security/post-sign-in-path.ts).
//
// Module pur : aucune dépendance d'environnement.
export const SHOPIFY_SHOPS_ARRIVAL_PATH = '/parametres?tab=shops';

// R2 — un effet après persistance (store_connection, synchronisation des produits) a échoué :
// la connexion reste réussie, la page d'arrivée annonce une synchronisation à relancer.
export const SHOPIFY_SYNC_PENDING_PARAM = 'sync=pending';

export function shopifyArrivalPath({
  hasSession,
  syncPending,
  connected = false,
}: {
  hasSession: boolean;
  syncPending: boolean;
  connected?: boolean;
}): string {
  if (!hasSession) {
    // La reprise ne porte que le chemin exact : `sync=pending` et `connected=1` ne survivent pas
    // à la connexion (limite assumée, R1). L'échec éventuel reste observable par sa sentinelle.
    return `/connexion?redirectTo=${encodeURIComponent(SHOPIFY_SHOPS_ARRIVAL_PATH)}`;
  }

  const params = [connected ? 'connected=1' : null, syncPending ? SHOPIFY_SYNC_PENDING_PARAM : null]
    .filter(Boolean)
    .join('&');
  return params ? `${SHOPIFY_SHOPS_ARRIVAL_PATH}&${params}` : SHOPIFY_SHOPS_ARRIVAL_PATH;
}
