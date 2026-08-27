'use client';

import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import type * as React from 'react';
import { useState } from 'react';

type ListCardSecondaryItem = {
  label: string;
  value: React.ReactNode;
};

type ListCardBase = {
  title: React.ReactNode;
  primaryValue: React.ReactNode;
  secondary?: ListCardSecondaryItem[];
  className?: string;
  moreLabel?: string;
};

type ListCardProps = ListCardBase &
  ({ href: string; onActivate?: never } | { href?: never; onActivate?: () => void });

/**
 * Remplace une ligne de tableau sur mobile : nom en tête, montant qui compte en évidence, le
 * reste replié. Cibles ≥48px CSS (`min-h-12`), espacement ≥8px CSS (`gap-2`) entre cibles
 * adjacentes — Tëër est une app web, ces valeurs sont en pixels CSS.
 *
 * Le tableau brut reste autorisé pour un seul cas : comparer plusieurs lignes sur une même
 * métrique, en 2 colonnes maximum. C'est du HTML natif, pas un composant de ce lot.
 */
export function ListCard({
  title,
  primaryValue,
  secondary,
  href,
  onActivate,
  className,
  moreLabel = 'Détails',
}: ListCardProps) {
  const [expanded, setExpanded] = useState(false);
  const hasSecondary = Boolean(secondary && secondary.length > 0);

  const header = (
    <span className="flex min-h-12 min-w-0 flex-1 items-center justify-between gap-3">
      <span className="min-w-0 truncate font-medium text-text">{title}</span>
      <span className="shrink-0 font-semibold text-text">{primaryValue}</span>
    </span>
  );

  return (
    <div
      className={cn('rounded-lg border border-border bg-surface px-4 py-2', className)}
      data-testid="list-card"
    >
      <div className="flex min-h-12 items-center gap-2">
        {href ? (
          <Link
            className="flex min-h-12 min-w-0 flex-1 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href={href}
          >
            {header}
          </Link>
        ) : onActivate ? (
          <button
            className="flex min-h-12 min-w-0 flex-1 items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onActivate}
            type="button"
          >
            {header}
          </button>
        ) : (
          header
        )}
        {hasSecondary ? (
          <button
            aria-expanded={expanded}
            className="ml-2 inline-flex min-h-12 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setExpanded((current) => !current)}
            type="button"
          >
            {moreLabel}
            <ChevronDown
              aria-hidden="true"
              className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
            />
          </button>
        ) : null}
      </div>
      {hasSecondary && expanded ? (
        <div className="grid gap-2 border-t border-border pt-2 pb-2">
          {secondary?.map((item) => (
            <div className="flex items-center justify-between gap-3 text-sm" key={item.label}>
              <span className="text-muted">{item.label}</span>
              <span className="text-text">{item.value}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
