/**
 * Détermine si `path` désigne une cible de redirection interne sûre ; retombe
 * sur `/tableau` sinon.
 *
 * Barrière UNIQUE, partagée par `signInAction` (`lib/actions/auth.ts`) et la
 * résolution d'entrée workspace (`resolveWorkspaceEntryPath`,
 * `lib/workspace/store-switch.ts`) — ne pas dupliquer cette définition
 * ailleurs. `redirectTo`/`next` sont dans les deux cas des paramètres d'URL
 * potentiellement contrôlés par un tiers (lien externe, redirection), jamais
 * une donnée interne de confiance : `resolveWorkspaceEntryPath` en a
 * spécifiquement besoin car `/s?next=` est une route GET ordinaire,
 * atteignable directement sans jamais passer par `signInAction`.
 *
 * Rejette :
 *  - toute cible qui ne commence pas par un unique `/` (URL absolue, schéma
 *    `javascript:`/`data:`, chemin relatif sans slash) ;
 *  - le chemin protocole-relatif (`//hote`) ;
 *  - toute occurrence de `\`, qu'un navigateur peut normaliser en `/`
 *    (`/\evil.example` devient `//evil.example` une fois interprété) —
 *    contournement classique d'un filtre qui ne teste que `//` ;
 *  - les contrôles ASCII et DEL, notamment ceux supprimés au parsing URL.
 */
export function safeRedirectPath(path: string | undefined): string {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    return '/tableau';
  }
  for (const char of path) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return '/tableau';
  }

  // URL parsing must preserve the origin as well as the textual path checks.
  // No request is made to this deliberately invalid, fixed origin.
  const base = 'https://redirect.invalid';
  try {
    if (new URL(path, base).origin !== base) return '/tableau';
  } catch {
    return '/tableau';
  }
  return path;
}
