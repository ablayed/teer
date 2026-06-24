import { AnalyticsProvider } from '@/components/analytics-provider';
import { AppShell } from '@/components/app-shell/app-shell';
import { IdleTimeout } from '@/components/auth/idle-timeout';
import { ServiceWorkerRegister } from '@/components/service-worker-register';
import { getMerchantAccountById, getMerchantMemberForUser } from '@/lib/actions/merchant';
import { getMissingCurrentConsents } from '@/lib/legal/consent';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/connexion');
  }

  // Everything below depends only on user.id and is mutually independent → one
  // parallel batch instead of a sequential cascade. Guards are still evaluated
  // in the original priority order (consent before onboarding); the merchant
  // account read (which depends on the member's merchant_account_id) follows.
  const [missingConsents, member, messages] = await Promise.all([
    getMissingCurrentConsents(user.id),
    getMerchantMemberForUser(user.id),
    getMessages(),
  ]);

  if (!missingConsents.ok || missingConsents.documents.length > 0) {
    redirect('/reacceptation');
  }

  // Utilisateur authentifié SANS organisation : on route selon ses invitations
  // en attente plutôt que de l'envoyer systématiquement vers l'onboarding. S'il
  // a au moins une invitation pending → /invitation/accept (mode liste, sans
  // token, qui ne re-route pas vers (app) → pas de boucle). Sinon → /onboarding
  // (non-régression du fondateur sans invitation). list_my_pending_invitations
  // est SECURITY DEFINER sur auth.uid() : appelée via le client cookie (RLS).
  if (!member) {
    const { data: pending, error: pendingError } = await (
      supabase as unknown as SupabaseClient<Database>
    ).rpc('list_my_pending_invitations');

    if (!pendingError && pending && pending.length > 0) {
      redirect('/invitation/accept');
    }

    redirect('/onboarding');
  }

  // Membre existant : fondateur en cours d'onboarding (compte non onboardé) reste
  // dirigé vers /onboarding, comme avant.
  const merchantAccount = await getMerchantAccountById(member.merchant_account_id);

  if (!merchantAccount?.onboarded_at) {
    redirect('/onboarding');
  }

  const idleTimeoutMs = Number(process.env.IDLE_TIMEOUT_MS) || 7_200_000;
  const idleWarningMs = Number(process.env.IDLE_WARNING_MS) || 120_000;

  return (
    <NextIntlClientProvider messages={messages}>
      <AnalyticsProvider />
      <ServiceWorkerRegister />
      <IdleTimeout timeoutMs={idleTimeoutMs} warningMs={idleWarningMs} />
      <AppShell currentRole={member?.role ?? null}>{children}</AppShell>
    </NextIntlClientProvider>
  );
}
