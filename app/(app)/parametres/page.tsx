import { SettingsProfile } from '@/components/settings/settings-profile';
import { getMerchantAccount } from '@/lib/actions/merchant';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';

type SupabaseServerClient = SupabaseClient<Database>;

export default async function ParametresPage() {
  const supabase = (await createSupabaseServerClient()) as unknown as SupabaseServerClient;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const merchantAccount = await getMerchantAccount();

  if (!user || !merchantAccount) {
    redirect('/connexion');
  }

  const { data: member } = await supabase
    .from('merchant_member')
    .select('role')
    .eq('merchant_account_id', merchantAccount.id)
    .eq('user_id', user.id)
    .maybeSingle();

  return (
    <main id="main">
      <SettingsProfile
        countryCode={merchantAccount.country_code}
        currentRole={member?.role ?? 'agent'}
        email={user.email ?? ''}
        ownerFullName={merchantAccount.owner_full_name ?? ''}
        shopName={merchantAccount.name}
        whatsapp={merchantAccount.whatsapp_e164 ?? ''}
      />
    </main>
  );
}
