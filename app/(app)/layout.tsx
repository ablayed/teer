import { AnalyticsProvider } from '@/components/analytics-provider';
import { AppShell } from '@/components/app-shell/app-shell';
import { ServiceWorkerRegister } from '@/components/service-worker-register';
import { getMerchantAccountById, getMerchantMemberForUser } from '@/lib/actions/merchant';
import { getMissingCurrentConsents } from '@/lib/legal/consent';
import { createSupabaseServerClient } from '@/lib/supabase/server';
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

  const merchantAccount = member ? await getMerchantAccountById(member.merchant_account_id) : null;

  if (!merchantAccount?.onboarded_at) {
    redirect('/onboarding');
  }

  return (
    <NextIntlClientProvider messages={messages}>
      <AnalyticsProvider />
      <ServiceWorkerRegister />
      <AppShell currentRole={member?.role ?? null}>{children}</AppShell>
    </NextIntlClientProvider>
  );
}
