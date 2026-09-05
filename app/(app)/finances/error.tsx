'use client';

import * as Sentry from '@sentry/nextjs';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';

export default function FinancesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('finance.loadError');

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="space-y-4" id="main">
      <section className="flex max-w-2xl flex-col gap-3 rounded-lg border border-danger/25 bg-danger-subtle p-5 text-danger shadow-1">
        <p className="text-sm font-medium">{t('title')}</p>
        <button
          className="min-h-12 self-start rounded-md bg-accent px-4 text-sm font-semibold text-text hover:bg-accent-hover"
          onClick={() => reset()}
          type="button"
        >
          {t('retry')}
        </button>
      </section>
    </main>
  );
}
