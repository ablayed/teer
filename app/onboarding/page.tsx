import { OnboardingFlow } from '@/components/onboarding/onboarding-flow';
import { getMerchantAccount } from '@/lib/actions/merchant';
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

  const merchantAccount = await getMerchantAccount();

  if (merchantAccount?.onboarded_at) {
    redirect('/tableau');
  }

  return <OnboardingFlow />;
}
