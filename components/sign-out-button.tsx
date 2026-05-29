'use client';

import { Button } from '@/components/ui/button';
import { signOutAction } from '@/lib/actions/auth';
import { LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';

export function SignOutButton() {
  const t = useTranslations('nav');
  const signOut = useAction(signOutAction);

  return (
    <Button onClick={() => signOut.execute()} size="sm" type="button" variant="ghost">
      <LogOut aria-hidden="true" className="size-4" />
      {t('signOut')}
    </Button>
  );
}
