import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { BottomTabNav } from './bottom-tab-nav';
import { Sidebar } from './sidebar';

export async function AppShell({ children }: { children: ReactNode }) {
  const t = await getTranslations('common');

  return (
    <div className="min-h-dvh bg-canvas text-text">
      <a
        className="sr-only left-4 top-4 z-50 rounded-md bg-surface px-4 py-2 font-medium text-text shadow-2 focus:not-sr-only focus:fixed"
        href="#main"
      >
        {t('skipToContent')}
      </a>
      <Sidebar />
      <div className="min-h-dvh px-4 pt-6 pb-20 md:ml-[280px] md:px-8 md:pt-10 md:pb-8">
        {children}
      </div>
      <BottomTabNav />
    </div>
  );
}
