import { reportAuthorizationFailure } from '@/lib/security/authz-audit';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { type TeamRole, isTeamRole, teamRoles } from '@/lib/team/permissions';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSafeActionClient } from 'next-safe-action';
import { z } from 'zod';

export { teamRoles, type TeamRole };
type SupabaseServerClient = SupabaseClient<Database>;

export const actionClient = createSafeActionClient({
  defineMetadataSchema() {
    return z.object({
      actionName: z.string(),
      section: z.string(),
    });
  },
  handleServerError(error, utils) {
    // DIAG (temporaire, branche diag/analyses-error-logging) : révéler l'exception
    // avalée par next-safe-action. Ne change PAS la valeur de retour opaque.
    // biome-ignore lint/suspicious/noConsole: diagnostic temporaire (branche diag)
    console.error(
      '[action-error]',
      JSON.stringify({
        actionName: utils?.metadata?.actionName,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    Sentry.captureException(error, {
      extra: { actionName: utils?.metadata?.actionName },
    });
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

export function requireRole(...allowedRoles: TeamRole[]) {
  return authActionClient.use(async ({ ctx, next, metadata }) => {
    const supabase = ctx.supabase as unknown as SupabaseServerClient;
    const { data: member, error } = await supabase
      .from('merchant_member')
      .select('id, merchant_account_id, role')
      .eq('user_id', ctx.user.id)
      .limit(1)
      .maybeSingle();

    if (error || !member || !isTeamRole(member.role) || !allowedRoles.includes(member.role)) {
      // OWASP A09 : trace l'échec de contrôle d'accès (tentative au-dessus du rôle).
      reportAuthorizationFailure({
        actionName: metadata?.actionName,
        section: metadata?.section,
        userId: ctx.user.id,
        merchantAccountId: member?.merchant_account_id ?? undefined,
        expectedRoles: allowedRoles,
        actualRole: member?.role ?? null,
      });
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
