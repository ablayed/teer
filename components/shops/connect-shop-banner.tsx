'use client';

import { cn } from '@/lib/utils';
import { Store, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';

type ConnectShopBannerProps = {
  hasShop: boolean;
};

export function ConnectShopBanner({ hasShop }: ConnectShopBannerProps) {
  const t = useTranslations('shops.banner');
  const [dismissed, setDismissed] = useState(false);

  if (hasShop || dismissed) {
    return null;
  }

  return (
    <section
      aria-label={t('ariaLabel')}
      className="rounded-lg border border-accent/40 bg-accent-soft/35 p-4 shadow-1"
    >
      <div className="flex gap-4">
        <span className="hidden size-11 shrink-0 items-center justify-center rounded-lg bg-surface text-accent md:flex">
          <Store aria-hidden="true" className="size-6" />
        </span>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-text">{t('title')}</h2>
            <p className="max-w-2xl text-sm leading-6 text-muted">{t('description')}</p>
          </div>
          <Link
            className={cn(
              'inline-flex min-h-12 items-center justify-center rounded-lg bg-accent px-5 font-medium text-[#111] transition hover:bg-accent-soft',
            )}
            href="/boutiques"
          >
            {t('cta')}
          </Link>
        </div>
        <button
          aria-label={t('dismiss')}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface hover:text-text"
          onClick={() => setDismissed(true)}
          type="button"
        >
          <X aria-hidden="true" className="size-5" />
        </button>
      </div>
    </section>
  );
}
