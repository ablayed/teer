import { OnboardingFlow } from '@/components/onboarding/onboarding-flow';
import { getMerchantAccount } from '@/lib/actions/merchant';
import { getMissingCurrentConsents } from '@/lib/legal/consent';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export default async function OnboardingPage() {
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
    redirect('/tableau');
  }

  return <OnboardingFlow />;
}
