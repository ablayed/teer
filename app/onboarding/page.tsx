import { OnboardingFlow } from '@/components/onboarding/onboarding-flow';
import { getMerchantAccount } from '@/lib/actions/merchant';
import { getMissingCurrentConsents } from '@/lib/legal/consent';
import { shopifyClaimResumePath } from '@/lib/shopify/claim-ticket';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

type OnboardingPageProps = {
  searchParams: Promise<{ redirectTo?: string | string[] }>;
};

export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  // SHOPIFY-OAUTH-FIRST-01 / D5 — seule reprise acceptée : le rattachement Shopify en attente.
  const rawRedirectTo = (await searchParams).redirectTo;
  const resumeTo = shopifyClaimResumePath(
    typeof rawRedirectTo === 'string' ? rawRedirectTo : undefined,
  );

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/connexion');
  }

  const missingConsents = await getMissingCurrentConsents(user.id);
  if (!missingConsents.ok || missingConsents.documents.length > 0) {
    redirect('/reacceptation');
  }

  const merchantAccount = await getMerchantAccount();

  if (merchantAccount?.onboarded_at) {
    redirect(resumeTo ?? '/tableau');
  }

  return <OnboardingFlow resumeTo={resumeTo} />;
}
