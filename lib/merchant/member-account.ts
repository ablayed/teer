// Lectures service-role du membre et du compte marchand. HELPERS INTERNES, jamais des actions.
//
// Ce fichier ne doit JAMAIS porter `'use server'`, ni être réexporté depuis un fichier qui le
// porte. Next enregistre chaque fonction exportée d'un fichier `'use server'` comme une Server
// Action : un point d'entrée HTTP, que le code appelant ne protège pas. Ces deux lectures
// prennent un identifiant en argument et contournent la RLS : elles n'ont pas à en être.
//
// Règle pour tout appelant : l'identifiant vient de la session lue dans la même requête
// (`supabase.auth.getUser()`), ou d'une valeur que la base vient de valider pour cette session.
// Jamais d'un paramètre, d'une URL, d'un en-tête ou d'un corps de requête.
// Gardes : tests/unit/security/use-server-service-role-exports.test.ts (analyse du dépôt) et
// tests/e2e/server-actions-anonymous-surface.spec.ts (build de production, vu de l'extérieur).
//
// `server-only` : le build échoue si un composant client importe ce module, au lieu d'en
// emporter le code. Next résout ce nom lui-même ; aucune dépendance n'est ajoutée.
import 'server-only';
import { env } from '@/lib/env';
import type { Tables } from '@/lib/supabase/database.types';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';

export type MerchantAccount = Tables<'merchant_account'>;
export type MerchantMember = { merchant_account_id: string; role: string };

function createSupabaseAdminClient() {
  return createProtectedSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

// Single `merchant_member` read returning both the tenant id and the role.
// Used by the (app) layout to avoid a second `merchant_member` round-trip just
// for the role. Admin client + `eq(user_id)` scopes to the authenticated user's
// own row, so the result is identical to the previous RLS-scoped read.
export async function getMerchantMemberForUser(userId: string): Promise<MerchantMember | null> {
  const admin = createSupabaseAdminClient();
  const { data: member, error } = await admin
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (member as MerchantMember | null) ?? null;
}

export async function getMerchantAccountById(accountId: string): Promise<MerchantAccount | null> {
  const admin = createSupabaseAdminClient();
  const { data: account, error } = await admin
    .from('merchant_account')
    .select('*')
    .eq('id', accountId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return account;
}
