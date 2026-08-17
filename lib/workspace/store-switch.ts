/**
 * Destination d'un changement de boutique.
 *
 * Le contrôle de boutique renvoyait systématiquement vers `/tableau` : changer de
 * boutique depuis `/livreurs` faisait perdre la section consultée. On préserve
 * désormais la SECTION courante quand elle existe dans la boutique cible.
 *
 * Deux choses sont volontairement ABANDONNÉES au passage, parce qu'elles
 * désignent une ressource d'une boutique et n'ont aucun sens dans une autre :
 *
 *  1. les segments au-delà de la section (`/commandes/{id}` → `/commandes`) —
 *     l'unique sous-route à ressource du produit est `commandes/[id]` ;
 *  2. les paramètres de requête dont la VALEUR est un UUID (`?driver={id}`), ainsi
 *     que `shop`, qui est le filtre boutique de l'ancienne boutique.
 *
 * C'est le « repli explicite au niveau section » demandé : on retombe sur la
 * section dans la boutique choisie, jamais sur la donnée d'une autre boutique.
 * Les paramètres de vue (`tab`, `period`, `from`, `to`, `q`, `vue`) survivent :
 * ils décrivent un affichage, pas une ressource.
 */

const STORE_PREFIX = /^\/s\/([0-9a-fA-F-]{36})(?=\/|$)/;
const UUID_VALUE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Paramètres portant une identité de boutique, toujours retirés au changement. */
const STORE_SCOPED_PARAMS = new Set(['shop']);

const DEFAULT_SECTION = 'tableau';

/**
 * Section courante, qu'on soit sur une URL canonique `/s/{id}/livreurs` ou sur
 * l'URL legacy `/livreurs` (toutes deux rendues en place depuis le correctif de
 * routage Phase 1).
 */
export function resolveWorkspaceSection(pathname: string): string {
  const withoutStore = pathname.replace(STORE_PREFIX, '');
  const [section] = withoutStore.split('/').filter(Boolean);
  return section ?? DEFAULT_SECTION;
}

export function buildStoreSwitchHref(
  pathname: string,
  storeId: string,
  search?: string | null,
): string {
  const section = resolveWorkspaceSection(pathname);
  const base = `/s/${storeId}/${section}`;

  if (!search) {
    return base;
  }

  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const [key, value] of [...params.entries()]) {
    if (STORE_SCOPED_PARAMS.has(key) || UUID_VALUE.test(value)) {
      params.delete(key);
    }
  }

  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
