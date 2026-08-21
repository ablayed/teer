import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

export type MemberlessDestination = '/invitation/accept' | '/onboarding';

/**
 * Destination d'un utilisateur authentifié SANS aucune organisation : route
 * selon ses invitations en attente plutôt que de l'envoyer systématiquement
 * vers l'onboarding (non-régression du fondateur sans invitation).
 * `list_my_pending_invitations` est SECURITY DEFINER sur `auth.uid()` (aucun
 * argument) — appelée via le client cookie (RLS), aucune migration requise.
 *
 * Pure : ne redirige jamais elle-même, renvoie la destination. Seule
 * définition de cette logique — consommée par `app/(app)/layout.tsx` (membre
 * absent) et `app/s/page.tsx` (0 boutique). Deux copies divergeraient.
 */
export async function resolveMemberlessDestination(
  supabase: SupabaseClient<Database>,
): Promise<MemberlessDestination> {
  const { data: pending, error } = await supabase.rpc('list_my_pending_invitations');

  if (!error && pending && pending.length > 0) {
    return '/invitation/accept';
  }

  return '/onboarding';
}
