import { publicEnv } from '@/lib/env';
import { assertProtectedSupabaseServerTarget } from '@/lib/supabase/protected-client';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from './database.types';

export async function createSupabaseServerClient() {
  assertProtectedSupabaseServerTarget(publicEnv.NEXT_PUBLIC_SUPABASE_URL);
  const cookieStore = await cookies();
  type CookieToSet = {
    name: string;
    value: string;
    options: Parameters<typeof cookieStore.set>[2];
  };

  return createServerClient<Database>(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            return;
          }
        },
      },
    },
  );
}
