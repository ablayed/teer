import { SettingsProfile } from '@/components/settings/settings-profile';
import { getMerchantAccount } from '@/lib/actions/merchant';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export default async function ParametresPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const merchantAccount = await getMerchantAccount();

  if (!user || !merchantAccount) {
    redirect('/connexion');
  }

  return (
    <main id="main">
      <SettingsProfile
        countryCode={merchantAccount.country_code}
        email={user.email ?? ''}
        ownerFullName={merchantAccount.owner_full_name ?? ''}
        shopName={merchantAccount.name}
        whatsapp={merchantAccount.whatsapp_e164 ?? ''}
      />
    </main>
  );
}
