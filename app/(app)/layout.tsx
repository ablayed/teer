import { AppShell } from '@/components/app-shell/app-shell';
import { getMerchantAccount } from '@/lib/actions/merchant';
import { createSupabaseServerClient } from '@/lib/supabase/server';
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

  const merchantAccount = await getMerchantAccount();

  if (!merchantAccount?.onboarded_at) {
    redirect('/onboarding');
  }

  const { data: member } = await supabase
    .from('merchant_member')
    .select('role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();
  const currentMember = member as { role: string } | null;

  return <AppShell currentRole={currentMember?.role ?? null}>{children}</AppShell>;
}
