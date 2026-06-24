'use server';

import { authActionClient } from '@/lib/actions/safe-action';
import { sendFeedbackEmail } from '@/lib/email/feedback-notification';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

type SupabaseServerClient = SupabaseClient<Database>;

const feedbackSchema = z.object({
  category: z.enum(['bug', 'suggestion', 'question', 'autre']),
  message: z.string().min(5).max(2000),
  pageContext: z.string().max(500).optional(),
  userAgent: z.string().max(500).optional(),
});

export const submitFeedbackAction = authActionClient
  .metadata({ actionName: 'support.submit_feedback', section: 'support' })
  .inputSchema(feedbackSchema)
  .action(async ({ ctx, parsedInput }) => {
    const supabase = ctx.supabase as unknown as SupabaseServerClient;
    const { data: member } = await supabase
      .from('merchant_member')
      .select('merchant_account_id')
      .eq('user_id', ctx.user.id)
      .limit(1)
      .maybeSingle();

    if (!member) {
      return { ok: false as const, errorCode: 'forbidden' as const };
    }

    const { error } = await supabase.from('feedback').insert({
      merchant_account_id: member.merchant_account_id,
      actor_user_id: ctx.user.id,
      category: parsedInput.category,
      message: parsedInput.message,
      page_context: parsedInput.pageContext ?? null,
      user_agent: parsedInput.userAgent ?? null,
    });

    if (error) {
      return { ok: false as const, errorCode: 'insert_error' as const };
    }

    // Email best-effort — ne fait jamais échouer l'action si Resend n'est pas configuré.
    try {
      await sendFeedbackEmail({
        category: parsedInput.category,
        merchantAccountId: member.merchant_account_id,
        message: parsedInput.message,
        pageContext: parsedInput.pageContext ?? null,
        userEmail: ctx.user.email ?? null,
      });
    } catch {
      // Silencieux — le feedback est enregistré en DB même sans email.
    }

    return { ok: true as const };
  });
