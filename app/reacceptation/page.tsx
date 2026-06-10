import { getMissingCurrentConsents } from '@/lib/legal/consent';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { ReacceptationForm } from './reacceptation-form';

export default async function ReacceptationPage({
  searchParams,
}: {
  searchParams: Promise<{ redirectTo?: string }>;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/connexion');
  }

  const missingConsents = await getMissingCurrentConsents(user.id);
  if (!missingConsents.ok) {
    redirect('/connexion');
  }

  if (missingConsents.documents.length === 0) {
    redirect('/tableau');
  }

  const params = await searchParams;

  return (
    <main className="landing flex min-h-dvh items-center justify-center bg-canvas px-5 py-12 text-text">
      <ReacceptationForm redirectTo={params.redirectTo} />
    </main>
  );
}
