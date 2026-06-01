import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSafeActionClient } from 'next-safe-action';
import { z } from 'zod';

export const teamRoles = ['owner', 'manager', 'agent'] as const;
export type TeamRole = (typeof teamRoles)[number];
type SupabaseServerClient = SupabaseClient<Database>;

export const actionClient = createSafeActionClient({
  defineMetadataSchema() {
    return z.object({
      actionName: z.string(),
      section: z.string(),
    });
  },
  handleServerError() {
    return 'UNEXPECTED_ERROR';
  },
});

export const authActionClient = actionClient.use(async ({ next }) => {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw new Error('UNAUTHENTICATED');
  }

  return next({
    ctx: {
      user,
      supabase,
    },
  });
});

function isTeamRole(role: string): role is TeamRole {
  return teamRoles.includes(role as TeamRole);
}

export function requireRole(...allowedRoles: TeamRole[]) {
  return authActionClient.use(async ({ ctx, next }) => {
    const supabase = ctx.supabase as unknown as SupabaseServerClient;
    const { data: member, error } = await supabase
      .from('merchant_member')
      .select('id, merchant_account_id, role')
      .eq('user_id', ctx.user.id)
      .limit(1)
      .maybeSingle();

    if (error || !member || !isTeamRole(member.role) || !allowedRoles.includes(member.role)) {
      throw new Error('FORBIDDEN');
    }

    return next({
      ctx: {
        ...ctx,
        member: {
          id: member.id,
          merchantAccountId: member.merchant_account_id,
          role: member.role,
        },
      },
    });
  });
}
