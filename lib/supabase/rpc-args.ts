/**
 * Override documenté et strictement localisé des types d'ARGUMENTS de RPC.
 *
 * PostgreSQL n'expose AUCUNE métadonnée de nullabilité pour les paramètres de
 * fonction : `pg_proc` ne connaît que le type et l'éventuelle valeur par défaut.
 * `supabase gen types` en déduit donc systématiquement un argument NON nullable
 * (`p_shop_id: string`), alors que la signature réelle `p_shop_id uuid` accepte
 * parfaitement NULL — et que le produit s'en sert : un accès PCD au niveau
 * organisation n'a, par construction, aucune boutique.
 *
 * Omettre la clé n'est pas une alternative : un paramètre SANS `default` doit
 * être fourni à PostgREST, sinon la signature ne résout pas. Il faut donc
 * transmettre NULL explicitement, ce que le type généré interdit.
 *
 * Ce helper matérialise cet écart à UN seul endroit, plutôt que de retoucher à
 * la main `database.types.ts` — un fichier qui doit rester intégralement
 * généré, sous peine d'être silencieusement écrasé au prochain `pnpm db:types`.
 *
 * À n'utiliser QUE pour un argument dont la signature SQL a été vérifiée comme
 * réellement nullable. Jamais pour contourner une colonne NOT NULL.
 */
export function nullableRpcArg<T extends string>(value: T | null | undefined): T {
  return (value ?? null) as unknown as T;
}
