'use client';

import { getActivationChecklistAction } from '@/lib/actions/support';
import { CheckCircle2, Circle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const DISMISS_KEY_PREFIX = 'teer-checklist-dismissed-';

type Step = {
  id: string;
  completed: boolean;
  href: string;
};

export function ActivationChecklist() {
  const t = useTranslations('onboarding.checklist');
  const { execute, result } = useAction(getActivationChecklistAction);
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  const checklist = result?.data?.ok ? result.data.checklist : null;

  // Charge la checklist au montage
  useEffect(() => {
    execute();
  }, [execute]);

  // Vérifie la préférence de dismiss côté client (localStorage)
  useEffect(() => {
    if (!checklist) return;
    const key = `${DISMISS_KEY_PREFIX}${checklist.merchantAccountId}`;
    setDismissed(localStorage.getItem(key) === '1');
  }, [checklist]);

  function dismiss() {
    if (!checklist) return;
    const key = `${DISMISS_KEY_PREFIX}${checklist.merchantAccountId}`;
    localStorage.setItem(key, '1');
    setDismissed(true);
  }

  // Masquer si : pas de données, tout complété, ou dismissed
  if (!checklist || checklist.allCompleted || dismissed) return null;

  const completedCount = checklist.steps.filter((s) => s.completed).length;
  const total = checklist.steps.length;
  const progressPct = Math.round((completedCount / total) * 100);

  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-1">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-text">{t('title')}</p>
          <p className="text-muted text-sm">{t('progress', { done: completedCount, total })}</p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('dismiss')}
          className="shrink-0 rounded-md px-2 py-1 text-xs text-muted transition hover:text-text"
        >
          {t('dismiss')}
        </button>
      </div>

      {/* Barre de progression */}
      <div
        className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-border"
        role="progressbar"
        tabIndex={0}
        aria-valuenow={progressPct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <ul className="flex flex-col gap-2">
        {checklist.steps.map((step) => (
          <StepRow key={step.id} step={step} />
        ))}
      </ul>
    </section>
  );
}

function StepRow({ step }: { step: Step }) {
  const t = useTranslations('onboarding.checklist');

  return (
    <li className="flex items-center gap-3">
      {step.completed ? (
        <CheckCircle2 aria-hidden="true" className="size-5 shrink-0 text-success" />
      ) : (
        <Circle aria-hidden="true" className="size-5 shrink-0 text-muted" />
      )}
      <span
        className={
          step.completed ? 'flex-1 text-sm text-muted line-through' : 'flex-1 text-sm text-text'
        }
      >
        {t(`steps.${step.id}`)}
      </span>
      {!step.completed ? (
        <Link
          href={step.href}
          className="shrink-0 rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-ink transition hover:bg-accent-hover"
        >
          {t('action')}
        </Link>
      ) : null}
    </li>
  );
}
