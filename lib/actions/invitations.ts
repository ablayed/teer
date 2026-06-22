'use server';

import { authActionClient } from '@/lib/actions/safe-action';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

type SupabaseServerClient = SupabaseClient<Database>;

const acceptPendingSchema = z.object({
  invitationId: z.string().uuid(),
});

// Codes d'erreur alignés sur les exceptions levées par la RPC SECURITY DEFINER
// accept_pending_invitation_by_email (migrations 0073/0074).
type AcceptInvitationErrorCode =
  | 'already_has_organization'
  | 'expired'
  | 'email_mismatch'
  | 'invalid';

function mapInvitationError(message: string | undefined): AcceptInvitationErrorCode {
  if (message?.includes('already_has_organization')) {
    return 'already_has_organization';
  }

  if (message?.includes('expired_invitation')) {
    return 'expired';
  }

  if (message?.includes('email_mismatch')) {
    return 'email_mismatch';
  }

  return 'invalid';
}

// Accepte une invitation déjà rattachée à l'e-mail du compte connecté (pas de
// token clair). La RPC est SECURITY DEFINER et lit auth.uid() : on l'appelle
// donc via ctx.supabase (client cookie respectant la session), jamais via le
// service-role qui aurait auth.uid() NULL → not_authenticated.
export const acceptPendingInvitationAction = authActionClient
  .metadata({ actionName: 'invitation.accept_pending', section: 'invitation' })
  .inputSchema(acceptPendingSchema)
  .action(async ({ ctx, parsedInput }) => {
    const supabase = ctx.supabase as unknown as SupabaseServerClient;
    const { data, error } = await supabase.rpc('accept_pending_invitation_by_email', {
      p_invitation_id: parsedInput.invitationId,
    });

    if (error) {
      return { ok: false as const, errorCode: mapInvitationError(error.message) };
    }

    const payload = (data ?? {}) as { role?: string };

    return { ok: true as const, role: payload.role ?? null };
  });
