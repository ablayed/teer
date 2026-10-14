import type { TransitionAction } from '@/lib/domain/order-transition-actions';

// Modèle du menu « Actions » d'une commande, sans le catalogue de transitions (V4). La liste de
// commandes n'a besoin que de savoir SI une carte a un menu : ce module léger le dit sans embarquer
// `order-transition-actions` (catalogue complet, RBAC, patches de dimensions). Le menu complet,
// lui, est chargé au premier appui (components/orders/order-actions-menu.tsx).
//
// Aucun import de valeur ici : `TransitionAction` n'est qu'un type.

// Phase 11 : « programmer » remplace « confirmer » dans les surfaces d'action
// (dropdown, kanban). confirmer reste légale au niveau moteur (chemins inline par
// target via getTransitionActionForTarget, rétro-compat CONFIRMEE) mais n'est
// jamais proposée à l'utilisateur quand programmer l'est — et programmer l'est
// dans TOUS les états où confirmer l'est (to_call/callback + unassigned).
// Réexportée par order-transition-actions : ses appelants existants sont inchangés.
export function visibleAllowedActions(actions: TransitionAction[]): TransitionAction[] {
  // Phase 11.1 : « demarrer_livraison » n'est JAMAIS une entrée de dropdown — elle
  // est déclenchée uniquement par le popup d'assignation (save + démarrage).
  const withoutStart = actions.filter((action) => action !== 'demarrer_livraison');
  if (!withoutStart.includes('programmer')) {
    return withoutStart;
  }
  return withoutStart.filter((action) => action !== 'confirmer');
}

// Ordre d'affichage du menu. FIX-UI-REFUS-01 : « refuser » n'y figure plus — l'action
// est retirée de la surface (cf. `retiredTransitionActions`). La remettre ici ne la
// ferait PAS réapparaître : `visibleActions` ne la contient plus.
export const transitionMenuOrder: TransitionAction[] = [
  'programmer',
  'reprogrammer',
  'annuler',
  'journaliser_appel',
  'confirmer',
  'deconfirmer',
  'assigner',
  'demarrer_livraison',
  'livrer',
  'mark_returned',
  // « Invalider » (0116) se lit juste après « Marquer retournée » : ce sont les deux seules
  // sorties d'une commande livrée, et les présenter côte à côte rend le choix explicite.
  'invalider',
  'desannuler',
];

export const destructiveMenuActions = new Set<TransitionAction>([
  'annuler',
  'mark_returned',
  'invalider',
]);

/** Les entrées de transition du menu, dans l'ordre d'affichage. */
export function menuTransitionEntries(allowedActions: TransitionAction[]): TransitionAction[] {
  const visible = visibleAllowedActions(allowedActions);
  return transitionMenuOrder.filter((action) => visible.includes(action));
}

/**
 * Le menu compact d'une carte a-t-il quelque chose à montrer ? Même règle que le menu complet
 * (`!hasMenu && !canCall` → rien) : la carte n'affiche son déclencheur que si le menu s'ouvrirait.
 */
export function compactMenuHasItems(allowedActions: TransitionAction[], phone: string | null) {
  return menuTransitionEntries(allowedActions).length > 0 || phone !== null;
}
