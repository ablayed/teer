// Server-only helper: imports Supabase server client and must not be imported by client
// components. No `server-only` package dependency here (QW4 rule: pas de nouvelle dépendance) —
// this file is already unreachable from the client by construction (it imports
// @/lib/supabase/server, cookie-based) and is only ever imported by app/(app)/tableau/page.tsx
// (RSC) and lib/actions/dashboard.ts ('use server').
//
// QW4 — dédupliquer les résolutions identité/marchand (auth.getUser() + merchant_member)
// répétées sur /tableau (9 résolutions indépendantes avant ce lot : page.tsx top-level,
// OperationsEssentialsSection, et chacune des 6 fonctions dashboard.ts consommées par les
// Suspense de /tableau). React.cache() est scopé à la requête (AsyncLocalStorage React Server
// Components, réinitialisé à chaque render) — aucune fuite cross-requête/cross-utilisateur,
// contrairement à unstable_cache/un cache global. Ne cache QUE l'identité (user/userId/
// merchantAccountId/role) ; aucun résultat métier (KPI, revenue, cash, etc.) n'est mémoïsé ici —
// chaque section continue d'appeler sa propre RPC/requête normalement.
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { cache } from 'react';

export type SupabaseServerClient = SupabaseClient<Database>;

function asTypedSupabaseClient(client: unknown): SupabaseServerClient {
  return client as SupabaseServerClient;
}

export type DashboardRequestContext =
  | {
      ok: true;
      supabase: SupabaseServerClient;
      user: User;
      userId: string;
      merchantAccountId: string;
      role: string;
    }
  | {
      ok: false;
      errorCode: 'unauthenticated' | 'member_not_found' | 'member_query_error';
    };

export const getCachedDashboardContext = cache(async (): Promise<DashboardRequestContext> => {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, errorCode: 'unauthenticated' };
  }

  const { data: member, error } = await supabase
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  if (error) {
    return { ok: false, errorCode: 'member_query_error' };
  }

  if (!member) {
    return { ok: false, errorCode: 'member_not_found' };
  }

  return {
    ok: true,
    supabase,
    user,
    userId: user.id,
    merchantAccountId: member.merchant_account_id,
    role: member.role,
  };
});
