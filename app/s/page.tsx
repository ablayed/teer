import { StoreChooser } from '@/components/workspace/store-chooser';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getWorkspaceStores } from '@/lib/workspace/store';
import { resolveWorkspaceEntryPath } from '@/lib/workspace/store-switch';
import { redirect } from 'next/navigation';

type WorkspaceEntryProps = {
  searchParams: Promise<{ next?: string }>;
};

/**
 * Point d'entrée après connexion.
 *
 *  - 0 boutique autorisée : état explicite « Aucune boutique accessible ».
 *  - 1 boutique : entrée automatique, par une redirection SERVEUR — le sélecteur
 *    n'est jamais rendu, donc jamais aperçu au passage.
 *  - 2 boutiques ou plus : choix explicite obligatoire. Aucune boutique n'est
 *    présélectionnée (ni la boutique par défaut, ni la dernière utilisée).
 *
 * Aucune donnée marchande n'est chargée ici : la page ne lit que la liste des
 * boutiques autorisées de l'utilisateur.
 */
export default async function WorkspaceEntryPage({ searchParams }: WorkspaceEntryProps) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/connexion?redirectTo=%2Fs');
  }

  const params = await searchParams;
  // L'intention de navigation est préservée intégralement (chemin + query) :
  // contrairement à `buildStoreSwitchHref` (changement de boutique), cette
  // entrée ne perd jamais la ressource visée. `next` est un paramètre d'URL
  // non fiable — accès direct possible à `/s?next=`, indépendant de
  // `signInAction` — voir les gardes de `resolveWorkspaceEntryPath`.
  const entryPath = resolveWorkspaceEntryPath(params.next);

  const stores = await getWorkspaceStores();

  if (stores.length === 1) {
    redirect(`/s/${stores[0].id}${entryPath}`);
  }

  return <StoreChooser entryPath={entryPath} stores={stores} />;
}
