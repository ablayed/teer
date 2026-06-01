import { Wordmark } from '@/components/wordmark';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

type InvitationAcceptPageProps = {
  searchParams: Promise<{ token?: string }>;
};
type SupabaseServerClient = SupabaseClient<Database>;

function loginRedirect(token: string): string {
  const params = new URLSearchParams();
  params.set('redirectTo', `/invitation/accept?token=${encodeURIComponent(token)}`);
  return `/connexion?${params.toString()}`;
}

type InvitationErrorKey = 'expired' | 'email_mismatch' | 'invalid';

function mapInvitationError(message: string | undefined): InvitationErrorKey {
  if (message?.includes('expired_invitation')) {
    return 'expired';
  }

  if (message?.includes('email_mismatch')) {
    return 'email_mismatch';
  }

  return 'invalid';
}

export default async function InvitationAcceptPage({ searchParams }: InvitationAcceptPageProps) {
  const t = await getTranslations('invitation.accept');
  const { token } = await searchParams;

  if (!token) {
    return <InvitationError cta={t('login')} message={t('invalid')} title={t('title')} />;
  }

  const supabase = (await createSupabaseServerClient()) as unknown as SupabaseServerClient;
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(loginRedirect(token));
  }

  const { error } = await supabase.rpc('accept_invitation', { p_token: token });

  if (!error) {
    redirect('/tableau?invitation=accepted');
  }

  const errorKey = mapInvitationError(error.message);
  return <InvitationError cta={t('login')} message={t(errorKey)} title={t('title')} />;
}

function InvitationError({ cta, message, title }: { cta: string; message: string; title: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-5 py-12 text-text">
      <section className="w-full max-w-[440px] rounded-lg border border-border bg-surface p-6 text-center shadow-1">
        <div className="mb-6 flex justify-center">
          <Wordmark size="md" />
        </div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-muted">{message}</p>
        <Link
          className="mt-6 inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-5 font-medium text-accent-ink transition hover:bg-accent-hover"
          href="/connexion"
        >
          {cta}
        </Link>
      </section>
    </main>
  );
}
