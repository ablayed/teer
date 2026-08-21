import { StoreChooser } from '@/components/workspace/store-chooser';
import { safeRedirectPath } from '@/lib/security/safe-redirect';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { resolveMemberlessDestination } from '@/lib/workspace/memberless-destination';
import { getWorkspaceStores } from '@/lib/workspace/store';
import { resolveWorkspaceEntryPath } from '@/lib/workspace/store-switch';
import type { SupabaseClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';

type WorkspaceEntryProps = {
  searchParams: Promise<{ next?: string }>;
};

/**
 * Point d'entrée après connexion.
 *
 *  - 0 boutique autorisée : rien à choisir, donc aucune réduction de section
 *    (`resolveWorkspaceEntryPath` n'a de sens que pour ENTRER dans une
 *    boutique). Route selon les invitations en attente
 *    (`resolveMemberlessDestination`, partagée avec `app/(app)/layout.tsx`) ;
 *    si la cible d'origine correspond déjà à la destination décidée (ex.
 *    `/invitation/accept?token=…`), elle est préservée intacte plutôt que
 *    remplacée par sa forme nue — sinon la destination décidée est utilisée
 *    telle quelle.
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
  // `next` reste une donnée non fiable, y compris à l'accès direct à `/s?next=`.
  // Cette barrière précède toutes les décisions mono/multi-boutiques.
  const safeNext = safeRedirectPath(params.next);
  const stores = await getWorkspaceStores();

  if (stores.length === 0) {
    const destination = await resolveMemberlessDestination(
      supabase as unknown as SupabaseClient<Database>,
    );
    redirect(safeNext.startsWith(destination) ? safeNext : destination);
  }

  if (stores.length === 1) {
    // Il n'existe aucune ambiguïté de choix inter-boutiques, donc le chemin peut
    // être préservé ; l'autorisation et la RLS décident ensuite entre accès et 404.
    redirect(`/s/${stores[0].id}${resolveWorkspaceEntryPath(safeNext)}`);
  }

  const [pathname, ...queryParts] = safeNext.split('?');
  return <StoreChooser pathname={pathname} search={queryParts.join('?')} stores={stores} />;
}
