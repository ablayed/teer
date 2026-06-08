import type { IaToolContext } from '@/lib/ia/types';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { type TeamRole, isTeamRole } from '@/lib/team/permissions';
import type { SupabaseClient } from '@supabase/supabase-js';

export type ResolvedIaContext =
  | { ok: true; ctx: Omit<IaToolContext, 'conversationId'> }
  | { ok: false; status: 401 | 403 };

// Résout le contexte d'exécution IA depuis la session : client JWT (RLS),
// utilisateur, tenant et rôle (lookup merchant_member, comme requireRole).
// JAMAIS de client service-role.
export async function resolveIaContext(): Promise<ResolvedIaContext> {
  const supabase = (await createSupabaseServerClient()) as unknown as SupabaseClient<Database>;
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, status: 401 };
  }

  const { data: member, error } = await supabase
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  if (error || !member || !isTeamRole(member.role)) {
    return { ok: false, status: 403 };
  }

  return {
    ok: true,
    ctx: {
      supabase,
      userId: user.id,
      merchantAccountId: member.merchant_account_id,
      role: member.role as TeamRole,
    },
  };
}
