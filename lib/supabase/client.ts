import {
  assertSupabaseHttpTarget,
  splitSupabaseAllowedOrigins,
} from '@/lib/security/supabase-target-policy';
import { createBrowserClient } from '@supabase/ssr';
import type { Database } from './database.types';

export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  assertSupabaseHttpTarget({
    target: url,
    variableName: 'NEXT_PUBLIC_SUPABASE_URL',
    context: 'browser',
    publicTarget: url,
    allowedOrigins: splitSupabaseAllowedOrigins(
      process.env.NEXT_PUBLIC_SUPABASE_ALLOWED_HTTP_ORIGINS,
    ),
  });

  return createBrowserClient<Database>(url ?? '', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '');
}
