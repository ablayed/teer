import { publicEnv } from '@/lib/env';
import { assertProtectedSupabaseServerTarget } from '@/lib/supabase/protected-client';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { cache } from 'react';
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

// Rendu en lecture seule uniquement. Les actions sensibles conservent getUser()
// pour vérifier la session auprès d'Auth. React.cache est limité au rendu courant.
export const getRequestClaims = cache(
  async (): Promise<{
    userId: string;
    email: string | null;
  } | null> => {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims || typeof data.claims.sub !== 'string' || !data.claims.sub) {
      return null;
    }
    return {
      userId: data.claims.sub,
      email: typeof data.claims.email === 'string' ? data.claims.email : null,
    };
  },
);
