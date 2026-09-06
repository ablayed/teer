import {
  assertSupabaseHttpTarget,
  splitSupabaseAllowedOrigins,
} from '@/lib/security/supabase-target-policy';
import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

type ClientOptions = Parameters<typeof createClient<Database>>[2];

function assertServerTarget(url: string | undefined): void {
  assertSupabaseHttpTarget({
    target: url,
    variableName: 'NEXT_PUBLIC_SUPABASE_URL',
    context: 'server',
    serverTarget: process.env.SUPABASE_URL,
    publicTarget: process.env.NEXT_PUBLIC_SUPABASE_URL,
    allowedOrigins: splitSupabaseAllowedOrigins(process.env.SUPABASE_ALLOWED_HTTP_ORIGINS),
    vercel: process.env.VERCEL,
    vercelEnvironment: process.env.VERCEL_ENV,
  });
}

/** Cree un client privilegie seulement apres controle de la cible HTTP. */
export function createProtectedSupabaseClient(
  url: string | undefined,
  key: string | undefined,
  options?: ClientOptions,
) {
  assertServerTarget(url);
  if (!key) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY: valeur absente');
  }
  return createClient<Database>(url ?? '', key, options);
}

export function assertProtectedSupabaseServerTarget(url: string | undefined): void {
  assertServerTarget(url);
}
