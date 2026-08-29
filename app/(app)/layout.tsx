import { AnalyticsProvider } from '@/components/analytics-provider';
import { AppShell } from '@/components/app-shell/app-shell';
import { IdleTimeout } from '@/components/auth/idle-timeout';
import { MutationQueueProvider } from '@/components/offline/mutation-queue-provider';
import { ServiceWorkerRegister } from '@/components/service-worker-register';
import { getMerchantAccountById, getMerchantMemberForUser } from '@/lib/actions/merchant';
import { getMissingCurrentConsents } from '@/lib/legal/consent';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { resolveMemberlessDestination } from '@/lib/workspace/memberless-destination';
import { defaultWorkspaceStore, getWorkspaceStores } from '@/lib/workspace/store';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
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
  // en attente plutôt que de l'envoyer systématiquement vers l'onboarding
  // (non-régression du fondateur sans invitation). Logique partagée avec
  // `app/s/page.tsx` (0 boutique) — lib/workspace/memberless-destination.ts,
  // une seule définition pour éviter deux copies divergentes.
  if (!member) {
    redirect(await resolveMemberlessDestination(supabase as unknown as SupabaseClient<Database>));
  }

  // Membre existant : fondateur en cours d'onboarding (compte non onboardé) reste
  // dirigé vers /onboarding, comme avant.
  const merchantAccount = await getMerchantAccountById(member.merchant_account_id);

  if (!merchantAccount?.onboarded_at) {
    redirect('/onboarding');
  }

  const [stores, requestHeaders] = await Promise.all([getWorkspaceStores(), headers()]);
  const isWorkspaceEntry = requestHeaders.get('x-teer-workspace-entry') === '1';

  if (stores.length === 0) {
    redirect('/onboarding');
  }

  if (isWorkspaceEntry) {
    return (
      <NextIntlClientProvider messages={messages}>
        <NuqsAdapter>{children}</NuqsAdapter>
      </NextIntlClientProvider>
    );
  }

  const requestStoreId = requestHeaders.get('x-teer-store-id');

  // Les URL legacy (/produits, /commandes, …) sont des chemins de compatibilité
  // RENDUS EN PLACE avec la boutique par défaut du workspace. Elles ne
  // redirigent plus vers /s/{storeId}, quel que soit le nombre de boutiques :
  // le middleware réécrit /s/{storeId}/X vers /X, donc redirect(layout) +
  // rewrite(middleware) formaient un cycle. Invisible sur une navigation
  // document (307 puis réécriture interne), ce cycle était re-parcouru
  // indéfiniment par le routeur client lors d'une navigation RSC : boucle de
  // requêtes silencieuse et page blanche terminale (diagnostic
  // PHASE1-DIAG-ROUTING). Les URL /s/{storeId}/… restent canoniques et sont
  // produites par toute la navigation interne et le sélecteur de boutique.
  const currentStore = requestStoreId
    ? (stores.find((store) => store.id === requestStoreId) ?? null)
    : defaultWorkspaceStore(stores);

  // Identifiant de boutique explicite mais inaccessible (forgé, révoqué, ou
  // appartenant à un autre tenant) : 404. Jamais de substitution silencieuse
  // vers une autre boutique — elle masquerait l'erreur et laisserait croire à
  // l'utilisateur qu'il consulte la boutique demandée.
  if (!currentStore) {
    notFound();
  }

  const idleTimeoutMs = Number(process.env.IDLE_TIMEOUT_MS) || 7_200_000;
  const idleWarningMs = Number(process.env.IDLE_WARNING_MS) || 120_000;

  return (
    <NextIntlClientProvider messages={messages}>
      <NuqsAdapter>
        <AnalyticsProvider />
        <ServiceWorkerRegister />
        <MutationQueueProvider />
        <IdleTimeout timeoutMs={idleTimeoutMs} warningMs={idleWarningMs} />
        <AppShell currentRole={currentStore.role} currentStore={currentStore} stores={stores}>
          {children}
        </AppShell>
      </NuqsAdapter>
    </NextIntlClientProvider>
  );
}
