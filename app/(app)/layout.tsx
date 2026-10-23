import { AnalyticsProvider } from '@/components/analytics-provider';
import { AppShell } from '@/components/app-shell/app-shell';
import { IdleTimeout } from '@/components/auth/idle-timeout';
import { MutationQueueProvider } from '@/components/offline/mutation-queue-provider';
import { ServiceWorkerRegister } from '@/components/service-worker-register';
import { pickMessages } from '@/lib/i18n/pick-messages';
import { getMissingCurrentConsents } from '@/lib/legal/consent';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient, getRequestClaims } from '@/lib/supabase/server';
import { resolveMemberlessDestination } from '@/lib/workspace/memberless-destination';
import { defaultWorkspaceStore, getAppBootstrap } from '@/lib/workspace/store';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import type { ReactNode } from 'react';

// L05 — une lecture lancée d'avance n'est attendue qu'à la place de sa garde. Si une garde
// antérieure redirige entre-temps, son échec éventuel ne doit pas devenir un rejet non géré ;
// attendue à sa place, la promesse d'origine rend son résultat ou lève son erreur, comme avant.
function startEarly<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  // L05 — ces lectures ne dépendent pas de l'utilisateur : elles partent tout de suite, au lieu
  // d'attendre leur tour derrière les gardes. Aucune n'est LUE avant sa garde, plus bas.
  // `getAppBootstrap` (un seul RPC, sous la RLS : boutiques, membre, compte) est mémoïsée par requête :
  // la page la demande déjà en parallèle du layout. Son erreur est CAPTURÉE ici et relevée plus bas,
  // pour que la garde de consentement garde sa priorité sur une erreur de lecture du membre.
  const messagesPromise = startEarly(getMessages());
  const bootstrapPromise = getAppBootstrap().then(
    (bootstrap) => ({ bootstrap, error: null }),
    (error: unknown) => ({ bootstrap: null, error }),
  );
  const storesPromise = startEarly(
    bootstrapPromise.then((result) => {
      if (result.error) throw result.error;
      if (!result.bootstrap) throw new Error('App bootstrap unavailable');
      return result.bootstrap.stores;
    }),
  );
  const headersPromise = startEarly(headers());

  const supabase = await createSupabaseServerClient();
  const claims = await getRequestClaims();

  if (!claims) {
    redirect('/connexion');
  }

  // Les consentements et le bootstrap restent concurrents ; les gardes ci-dessous gardent leur ordre
  // de priorité d'origine (consentement avant onboarding).
  const [missingConsents, bootstrapResult, messages] = await Promise.all([
    getMissingCurrentConsents(claims.userId),
    bootstrapPromise,
    messagesPromise,
  ]);

  if (!missingConsents.ok || missingConsents.documents.length > 0) {
    redirect('/reacceptation');
  }

  if (bootstrapResult.error) throw bootstrapResult.error;
  const bootstrap = bootstrapResult.bootstrap;
  if (!bootstrap) throw new Error('App bootstrap unavailable');
  const { member } = bootstrap;

  // Messages de la COQUE seulement (V3) : chaque page déclare les siens (`withMessages`). Ce tableau
  // est lu tel quel par tests/unit/i18n/namespace-coverage.test.ts : il doit rester un littéral.
  const shellMessages = pickMessages(messages as never, [
    'nav',
    'settings.idle',
    'finance.loadError',
  ]);

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
  const merchantAccount = bootstrap.account;

  if (!merchantAccount?.onboarded_at) {
    redirect('/onboarding');
  }

  const [stores, requestHeaders] = await Promise.all([storesPromise, headersPromise]);
  const isWorkspaceEntry = requestHeaders.get('x-teer-workspace-entry') === '1';

  if (stores.length === 0) {
    redirect('/onboarding');
  }

  if (isWorkspaceEntry) {
    return (
      <NextIntlClientProvider messages={shellMessages}>
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
    <NextIntlClientProvider messages={shellMessages}>
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
