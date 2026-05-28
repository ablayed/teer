'use server';

import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createSafeActionClient } from 'next-safe-action';
import { z } from 'zod';

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
