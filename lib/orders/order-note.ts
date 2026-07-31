// Note libre d'équipe sur la commande (migration 0118).
//
// Ce module est volontairement PUR : il n'importe ni `lib/env.ts`, ni un client
// Supabase, ni `'use server'`. Il reste donc unit-testable sans monter tout
// l'environnement serveur (gotcha projet : importer un seul export d'un fichier
// qui importe `env` déclenche la validation zod des variables serveur).

// 500 caractères : reprend la convention déjà en place dans le compteur du
// composant `CallLogDialog`/`CallLogForm` (`{note.length}/500`), pour que les
// deux saisies de note du produit partagent la même limite. La contrainte
// `orders_note_max_length` et `set_order_note` appliquent la même valeur côté
// base — c'est la limite serveur qui fait foi, le compteur n'est qu'un confort.
export const ORDER_NOTE_MAX_LENGTH = 500;

/**
 * Normalise une saisie de note vers ce qui sera réellement stocké.
 * Une note vide (ou uniquement des espaces) vaut `null`, jamais `''` :
 * la colonne est nullable et « pas de note » doit avoir une seule
 * représentation en base.
 */
export function normalizeOrderNote(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}
