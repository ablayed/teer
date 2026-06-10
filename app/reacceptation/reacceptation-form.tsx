'use client';

import { Button } from '@/components/ui/button';
import { Wordmark } from '@/components/wordmark';
import { acceptCurrentLegalDocumentsAction } from '@/lib/actions/legal';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import Link from 'next/link';
import { useState } from 'react';

export function ReacceptationForm({
  redirectTo,
}: {
  redirectTo?: string;
}) {
  const t = useTranslations('legalReaccept');
  const tErrors = useTranslations('auth.errors');
  const [acceptedLegal, setAcceptedLegal] = useState(false);
  const acceptAction = useAction(acceptCurrentLegalDocumentsAction);

  const errorCode =
    acceptAction.result.data?.ok === false ? acceptAction.result.data.errorCode : undefined;
  const actionError = errorCode ? tErrors(errorCode) : acceptAction.result.serverError;

  return (
    <section className="w-full max-w-[480px] rounded-[28px] border border-border bg-surface p-8 shadow-1">
      <div className="mb-8 flex justify-center">
        <Wordmark size="md" />
      </div>

      <div className="space-y-4 text-center">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-accent-deep">
          {t('eyebrow')}
        </p>
        <h1 className="text-balance font-display text-4xl leading-tight tracking-[-0.02em] text-text">
          {t('title')}
        </h1>
        <p className="text-pretty text-sm leading-7 text-muted">{t('body')}</p>
      </div>

      <form
        className="mt-8 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          acceptAction.execute({ acceptedLegal: true, redirectTo });
        }}
      >
        <div className="rounded-xl border border-border bg-canvas/80 p-4">
          <label
            className="flex items-start gap-3 text-sm leading-6 text-text"
            htmlFor="acceptedLegalReaccept"
          >
            <input
              checked={acceptedLegal}
              className="mt-1 h-4 w-4 rounded border-border text-accent focus:ring-accent"
              id="acceptedLegalReaccept"
              onChange={(event) => setAcceptedLegal(event.target.checked)}
              type="checkbox"
            />
            <span>
              {t('consentPrefix')}{' '}
              <Link
                className="text-accent-deep underline underline-offset-2"
                href="/conditions"
                rel="noreferrer"
                target="_blank"
              >
                {t('terms')}
              </Link>{' '}
              {t('joiner')}{' '}
              <Link
                className="text-accent-deep underline underline-offset-2"
                href="/confidentialite"
                rel="noreferrer"
                target="_blank"
              >
                {t('privacy')}
              </Link>
              .
            </span>
          </label>
        </div>

        {actionError ? (
          <p className="text-sm text-danger" role="alert">
            {actionError}
          </p>
        ) : null}

        <Button
          className="w-full"
          disabled={!acceptedLegal || acceptAction.isExecuting}
          type="submit"
        >
          {t('submit')}
        </Button>
      </form>
    </section>
  );
}
