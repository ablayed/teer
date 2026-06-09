import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { BottomTabNav } from './bottom-tab-nav';
import { Sidebar } from './sidebar';

export async function AppShell({
  children,
  currentRole,
}: {
  children: ReactNode;
  currentRole?: string | null;
}) {
  const t = await getTranslations('common');

  return (
    <div className="min-h-dvh bg-canvas text-text">
      <a
        className="sr-only left-4 top-4 z-50 rounded-md bg-surface px-4 py-2 font-medium text-text shadow-2 focus:not-sr-only focus:fixed"
        href="#main"
      >
        {t('skipToContent')}
      </a>
      <Sidebar currentRole={currentRole} />
      {/*
        Mobile : zone de défilement bornée AU-DESSUS de la bottom-tab-nav fixe
        (h = 64px + safe-area). Sans hauteur bornée, un élément amené en bas du viewport
        (scrollIntoView) tombe SOUS la nav (z-40, opaque) et devient inatteignable au clic —
        bug réel reproduit sur pixel-7 (clic « Ajouter une dépense » intercepté par la nav).
        Desktop (md+) : pas de bottom-nav (md:hidden) → défilement document classique.
      */}
      <div className="h-[calc(100dvh-64px-env(safe-area-inset-bottom))] overflow-y-auto overscroll-contain px-4 pt-6 pb-6 md:ml-[280px] md:h-auto md:min-h-dvh md:overflow-visible md:px-8 md:pt-10 md:pb-8">
        {children}
      </div>
      <BottomTabNav currentRole={currentRole} />
    </div>
  );
}
