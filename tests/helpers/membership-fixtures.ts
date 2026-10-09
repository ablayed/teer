import type { SupabaseClient } from '@supabase/supabase-js';
import type { TestPostgresClient } from './postgres-client';

// Fixtures d'appartenance compatibles avec la garde du dernier owner (migration 0162).
//
// Un utilisateur de test naît propriétaire unique du compte créé à son inscription
// (`handle_new_user`). Retirer ou rétrograder cette ligne est refusé par la base, pour tous les
// rôles (`last_owner`, 23514). Deux façons légitimes de préparer un état :
//   * supprimer le compte d'inscription — la cascade emporte l'appartenance ;
//   * donner d'abord un second owner au compte.

// biome-ignore lint/suspicious/noExplicitAny: les suites passent des clients typés ou non.
type AnyAdminClient = SupabaseClient<any, any, any>;

/** Sort l'utilisateur du compte créé à son inscription, en supprimant ce compte. */
export async function leaveSignupAccount(admin: AnyAdminClient, userId: string): Promise<void> {
  const { error } = await admin.from('merchant_account').delete().eq('owner_user_id', userId);
  if (error) throw new Error(`leaveSignupAccount: ${error.message}`);
}

/** SQL direct : fait d'un utilisateur existant un second owner du compte, après l'avoir sorti du sien. */
export async function addSecondOwnerSql(
  client: TestPostgresClient,
  merchantAccountId: string,
  userId: string,
): Promise<void> {
  await client.query('delete from public.merchant_account where owner_user_id = $1', [userId]);
  await client.query(
    `insert into public.merchant_member (merchant_account_id, user_id, role)
     values ($1, $2, 'owner')`,
    [merchantAccountId, userId],
  );
}

/** SQL direct : retire le second owner ajouté par `addSecondOwnerSql`. */
export async function removeSecondOwnerSql(
  client: TestPostgresClient,
  merchantAccountId: string,
  userId: string,
): Promise<void> {
  await client.query(
    'delete from public.merchant_member where merchant_account_id = $1 and user_id = $2',
    [merchantAccountId, userId],
  );
}
