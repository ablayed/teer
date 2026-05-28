'use client';

import { Button } from '@/components/ui/button';
import { signOutAction } from '@/lib/actions/auth';
import { LogOut } from 'lucide-react';
import { useAction } from 'next-safe-action/hooks';

export function SignOutButton({ label }: { label: string }) {
  const signOut = useAction(signOutAction);

  return (
    <Button onClick={() => signOut.execute()} size="sm" type="button" variant="ghost">
      <LogOut aria-hidden="true" className="size-4" />
      {label}
    </Button>
  );
}
