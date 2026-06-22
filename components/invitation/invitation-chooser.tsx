'use client';

import { Button } from '@/components/ui/button';
import { Wordmark } from '@/components/wordmark';
import { acceptPendingInvitationAction } from '@/lib/actions/invitations';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export type PendingInvitation = {
  id: string;
  orgName: string;
  role: string;
};

type ErrorKey = 'already_has_organization' | 'expired' | 'email_mismatch' | 'invalid';

function welcomeHref(orgName: string, role: string): string {
  const params = new URLSearchParams();
  params.set('welcome', orgName);
  params.set('role', role);
  return `/tableau?${params.toString()}`;
}

export function InvitationChooser({ invitations }: { invitations: PendingInvitation[] }) {
  const t = useTranslations('invitation');
  const router = useRouter();
  const accept = useAction(acceptPendingInvitationAction);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function roleLabel(role: string): string {
    return role === 'owner' || role === 'manager' || role === 'agent' ? t(`roles.${role}`) : role;
  }

  async function onAccept(invitation: PendingInvitation) {
    setError(null);
    setPendingId(invitation.id);
    const result = await accept.executeAsync({ invitationId: invitation.id });

    if (result?.data?.ok) {
      router.push(welcomeHref(invitation.orgName, invitation.role));
      return;
    }

    setPendingId(null);
    const errorCode = (result?.data && !result.data.ok ? result.data.errorCode : 'invalid') as
      | ErrorKey
      | undefined;
    setError(t(`accept.${errorCode ?? 'invalid'}`));
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-5 py-12 text-text">
      <section className="w-full max-w-[440px] rounded-lg border border-border bg-surface p-6 shadow-1">
        <div className="mb-6 flex justify-center">
          <Wordmark size="md" />
        </div>
        <h1 className="text-center text-xl font-semibold">{t('accept.chooseTitle')}</h1>
        <p className="mt-2 text-center text-sm leading-6 text-muted">
          {t('accept.chooseSubtitle')}
        </p>

        {error ? (
          <p
            className="mt-4 rounded-lg border border-danger/30 bg-danger-subtle p-3 text-sm text-danger"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <ul className="mt-6 space-y-3">
          {invitations.map((invitation) => (
            <li
              className="flex items-center justify-between gap-3 rounded-md border border-border bg-canvas p-4"
              key={invitation.id}
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-text">{invitation.orgName}</p>
                <p className="text-sm text-muted">
                  {t('accept.orgRole', { role: roleLabel(invitation.role) })}
                </p>
              </div>
              <Button
                disabled={accept.isExecuting}
                onClick={() => onAccept(invitation)}
                size="sm"
                type="button"
              >
                {pendingId === invitation.id ? t('accept.accepting') : t('accept.accept')}
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
