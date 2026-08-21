/**
 * Résolution de boutique — deux fonctions pour deux besoins opposés, à ne pas
 * fusionner :
 *
 *  - `resolveWorkspaceSection` (→ `buildStoreSwitchHref`) : changement de
 *    boutique, MÊME session. Réduit à la section, parce qu'une ressource
 *    (`/commandes/{id}`) ou un paramètre identifiant (`?driver={id}`, `?shop=`)
 *    appartient à l'ANCIENNE boutique et n'a aucun sens dans la nouvelle.
 *  - `resolveWorkspaceEntryPath` (→ `app/s/page.tsx`) : entrée post-connexion
 *    dans la boutique qui vient d'être choisie. Préserve le chemin complet :
 *    l'intention de navigation de l'utilisateur (`/commandes/{id}`) reste
 *    valide dans la boutique qu'il vient lui-même de sélectionner.
 *
 * L'invariant « ne jamais émettre une URL non routable » ne porte QUE sur la
 * première : son URL est DÉRIVÉE, personne ne l'a demandée. La seconde reflète
 * une intention utilisateur — un 404 sur le reste du chemin y est un résultat
 * légitime (`/commandes/pas-un-uuid` 404e déjà aujourd'hui), pas un défaut à
 * éliminer. Voir `ROUTABLE_SECTIONS` vs `KNOWN_TOP_LEVEL_SEGMENTS` ci-dessous.
 */

import { safeRedirectPath } from '@/lib/security/safe-redirect';

const STORE_PREFIX = /^\/s\/([0-9a-fA-F-]{36})(?=\/|$)/;
const UUID_VALUE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Paramètres portant une identité de boutique, toujours retirés au changement. */
const STORE_SCOPED_PARAMS = new Set(['shop']);

const DEFAULT_SECTION = 'tableau';

/**
 * Sections routables NUES : chacune a son propre `page.tsx` directement sous
 * `app/(app)/{section}`, donc `/s/{id}/{section}` résout toujours une page.
 *
 * `dev` en est volontairement absent : seul `/dev/primitives` (2 segments,
 * lui-même gardé par `ENABLE_PRIMITIVES_DEMO`) est routable — `app/(app)/dev`
 * n'a AUCUN `page.tsx`, donc `/s/{id}/dev` 404e systématiquement. C'est
 * exactement le défaut que cette allowlist corrige : avant elle,
 * `resolveWorkspaceSection('/dev/primitives')` réduisait à `dev` et émettait
 * une URL non routable par construction.
 */
const ROUTABLE_SECTIONS = new Set([
  'analyses',
  'assistant',
  'boutiques',
  'clients',
  'commandes',
  'finances',
  'livreurs',
  'parametres',
  'produits',
  'tableau',
]);

/**
 * Namespaces de premier niveau connus, pour `resolveWorkspaceEntryPath`
 * uniquement. Sur-ensemble DÉLIBÉRÉ de `ROUTABLE_SECTIONS` (jamais l'inverse,
 * pour ne pas dériver silencieusement) : `dev` y est légitime, alors qu'il
 * est exclu de `ROUTABLE_SECTIONS` — cf. le commentaire ci-dessus sur l'unicité
 * de l'invariant « jamais 404 ».
 */
const KNOWN_TOP_LEVEL_SEGMENTS = new Set<string>([...ROUTABLE_SECTIONS, 'dev']);

/**
 * Section courante, qu'on soit sur une URL canonique `/s/{id}/livreurs` ou sur
 * l'URL legacy `/livreurs` (toutes deux rendues en place depuis le correctif de
 * routage Phase 1).
 *
 * Retombe sur `DEFAULT_SECTION` si la section réduite n'est pas routable nue
 * (cf. `ROUTABLE_SECTIONS`) — l'invariant de cette fonction est de ne JAMAIS
 * produire une URL dérivée non routable.
 */
export function resolveWorkspaceSection(pathname: string): string {
  const withoutStore = pathname.replace(STORE_PREFIX, '');
  const [section] = withoutStore.split('/').filter(Boolean);
  if (!section || !ROUTABLE_SECTIONS.has(section)) {
    return DEFAULT_SECTION;
  }
  return section;
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
    // Le contrat retire `shop` et les valeurs UUID ; un identifiant sous une
    // autre forme (slug, par exemple) reste volontairement hors de ce filtre.
    // `delete(key)` retire toutes les occurrences de la clé, comportement voulu
    // et sans dépendance actuelle à des paramètres multi-valués.
    if (STORE_SCOPED_PARAMS.has(key) || UUID_VALUE.test(value)) {
      params.delete(key);
    }
  }

  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/**
 * Chemin d'entrée workspace complet, pour l'atterrissage post-connexion
 * (`app/s/page.tsx`). PRÉSERVE l'intention de navigation au lieu de la
 * réduire, contrairement à `resolveWorkspaceSection`.
 *
 * Trois gardes, dans cet ordre :
 *
 *  1. `safeRedirectPath` — barrière UNIQUE partagée avec `signInAction`
 *     (`lib/actions/auth.ts`) contre les cibles externes (URL absolue, schéma,
 *     protocole-relatif, backslash). Nécessaire ici indépendamment de cette
 *     action : `/s?next=` est une route GET ordinaire, atteignable
 *     directement sans jamais passer par `signInAction` en amont — sans cette
 *     garde, ce point d'entrée serait une redirection ouverte.
 *  2. Dé-doublonnage d'un éventuel préfixe `/s/{id}` déjà présent, pour ne
 *     jamais produire `/s/{id}/s/{id}/…`.
 *  3. Le premier segment doit appartenir à `KNOWN_TOP_LEVEL_SEGMENTS`. Un
 *     namespace inconnu retombe sur `DEFAULT_SECTION`. Au-delà de ce premier
 *     segment, le chemin n'est PAS revérifié : un 404 sur le reste
 *     (`/commandes/pas-un-uuid`) est un résultat légitime, ce n'est pas une
 *     URL dérivée — voir le commentaire d'en-tête du fichier.
 */
export function resolveWorkspaceEntryPath(rawPath: string | undefined): string {
  const safePath = safeRedirectPath(rawPath);

  const [rawPathname, ...queryParts] = safePath.split('?');
  const query = queryParts.join('?');
  const pathname = (rawPathname ?? '').replace(STORE_PREFIX, '') || '/';
  const [firstSegment] = pathname.split('/').filter(Boolean);

  if (!firstSegment || !KNOWN_TOP_LEVEL_SEGMENTS.has(firstSegment)) {
    return `/${DEFAULT_SECTION}`;
  }

  return query ? `${pathname}?${query}` : pathname;
}
