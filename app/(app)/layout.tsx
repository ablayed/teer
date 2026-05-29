import { SignOutButton } from '@/components/sign-out-button';
import { Wordmark } from '@/components/wordmark';
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

  return (
    <main className="min-h-dvh bg-canvas text-text">
      <header className="h-16 border-b border-border bg-surface">
        <div className="mx-auto flex h-full max-w-6xl items-center justify-between px-5">
          <Wordmark size="sm" />
          <SignOutButton />
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-5 py-10">{children}</div>
    </main>
  );
}
