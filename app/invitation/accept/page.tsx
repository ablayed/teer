import {
  InvitationChooser,
  type PendingInvitation,
} from '@/components/invitation/invitation-chooser';
import { Wordmark } from '@/components/wordmark';
import { getMerchantAccountById } from '@/lib/actions/merchant';
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

// Toujours réinjecter le token dans le retour de connexion : un refresh de la
// page ou une (re)connexion repasse par /invitation/accept?token=... sans le
// perdre. Sans token (mode liste), on revient sur /invitation/accept tout court.
function loginRedirect(token?: string): string {
  const params = new URLSearchParams();
  params.set(
    'redirectTo',
    token ? `/invitation/accept?token=${encodeURIComponent(token)}` : '/invitation/accept',
  );
  return `/connexion?${params.toString()}`;
}

type InvitationErrorKey = 'expired' | 'email_mismatch' | 'already_has_organization' | 'invalid';

function mapInvitationError(message: string | undefined): InvitationErrorKey {
  if (message?.includes('already_has_organization')) {
    return 'already_has_organization';
  }

  if (message?.includes('expired_invitation')) {
    return 'expired';
  }

  if (message?.includes('email_mismatch')) {
    return 'email_mismatch';
  }

  return 'invalid';
}

function welcomeRedirect(orgName: string, role: string): string {
  const params = new URLSearchParams();
  params.set('welcome', orgName);
  params.set('role', role);
  return `/tableau?${params.toString()}`;
}

export default async function InvitationAcceptPage({ searchParams }: InvitationAcceptPageProps) {
  const t = await getTranslations('invitation.accept');
  const { token } = await searchParams;

  const supabase = (await createSupabaseServerClient()) as unknown as SupabaseServerClient;
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // --- Chemin nominal : token présent (lien e-mail / WhatsApp). ---
  if (token) {
    if (!user) {
      redirect(loginRedirect(token));
    }

    const { data, error } = await supabase.rpc('accept_invitation', { p_token: token });

    if (!error) {
      const payload = (data ?? {}) as { merchant_account_id?: string; role?: string };
      const account = payload.merchant_account_id
        ? await getMerchantAccountById(payload.merchant_account_id)
        : null;
      redirect(welcomeRedirect(account?.name ?? '', payload.role ?? ''));
    }

    // Tout chemin d'erreur réinjecte le token : la (re)connexion réessaie le flux.
    return (
      <InvitationError
        cta={t('login')}
        href={loginRedirect(token)}
        message={t(mapInvitationError(error.message))}
        title={t('title')}
      />
    );
  }

  // --- Mode sans token : liste des invitations en attente. ---
  if (!user) {
    redirect(loginRedirect());
  }

  const { data: pending, error: listError } = await supabase.rpc('list_my_pending_invitations');

  if (listError || !pending || pending.length === 0) {
    return (
      <InvitationError
        cta={t('emptyCta')}
        href="/onboarding"
        message={t('empty')}
        title={t('title')}
      />
    );
  }

  const invitations: PendingInvitation[] = pending.map((invitation) => ({
    id: invitation.id,
    orgName: invitation.org_name,
    role: invitation.role,
  }));

  return <InvitationChooser invitations={invitations} />;
}

function InvitationError({
  cta,
  href,
  message,
  title,
}: {
  cta: string;
  href: string;
  message: string;
  title: string;
}) {
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
          href={href}
        >
          {cta}
        </Link>
      </section>
    </main>
  );
}
