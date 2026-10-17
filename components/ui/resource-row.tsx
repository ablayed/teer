'use client';

import { cn } from '@/lib/utils';
import Link from 'next/link';
import type * as React from 'react';

type ResourceRowBase = {
  leading?: React.ReactNode;
  title: React.ReactNode;
  /**
   * Nombre de lignes avant troncature du titre. Défaut `1` (comportement
   * historique, inchangé pour tout appelant existant). Passer `2` pour un
   * titre potentiellement long dont la troncature à 1 ligne rend deux
   * variantes à préfixe commun indistinguables (Produits/UX-CAT-01).
   */
  titleLineClamp?: 1 | 2;
  meta?: React.ReactNode;
  status?: React.ReactNode;
  primaryAction?: React.ReactNode;
  overflow?: React.ReactNode;
  className?: string;
  testId?: string;
};

type ResourceRowWithHref = ResourceRowBase & {
  href: string;
  onActivate?: never;
  /**
   * Passe `false` pour désactiver le prefetch Next (défaut: comportement natif = true).
   * Utile quand le jeu de lignes/liens change à haute fréquence (ex. recherche instantanée
   * `/commandes`) : sans ça, chaque frappe monte de nouveaux `<Link>` qui déclenchent chacun
   * un prefetch RSC concurrent, souvent annulé avant résolution.
   */
  prefetch?: boolean;
  scroll?: boolean;
  /**
   * Étend la zone du lien à toute la carte (motif du « lien étendu » : pseudo-élément du lien
   * positionné sur la rangée). Statut, montant et marges mènent alors à la même destination,
   * par le même vrai lien natif ; seul `overflow` reste au-dessus du lien, hors de sa zone.
   * Réservé aux rangées dont `status` et `primaryAction` ne sont pas interactifs.
   */
  fullSurfaceLink?: boolean;
};
type ResourceRowWithActivate = ResourceRowBase & {
  href?: never;
  onActivate?: () => void;
  prefetch?: never;
  scroll?: never;
  fullSurfaceLink?: never;
};

export type ResourceRowProps = ResourceRowWithHref | ResourceRowWithActivate;

export function ResourceRow({
  href,
  onActivate,
  leading,
  title,
  titleLineClamp = 1,
  meta,
  status,
  primaryAction,
  overflow,
  className,
  prefetch,
  scroll,
  fullSurfaceLink,
  testId,
}: ResourceRowProps) {
  const extended = Boolean(href) && Boolean(fullSurfaceLink);
  const mainContent = (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      {leading}
      <span className="min-w-0 flex-1">
        <span
          className={cn('block font-medium', titleLineClamp === 2 ? 'line-clamp-2' : 'truncate')}
        >
          {title}
        </span>
        {meta ? (
          <span className="@max-[22rem]/row:hidden block truncate text-sm text-muted">{meta}</span>
        ) : null}
      </span>
    </span>
  );

  const linkClasses = cn(
    'flex min-w-0 flex-1 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-surface',
    // Le pseudo-élément couvre la rangée (ancêtre `relative`) ; la bague de focus est portée par
    // lui pour entourer toute la carte, et l'appui est rendu sur la rangée entière.
    extended &&
      "after:absolute after:inset-0 after:rounded-md after:content-[''] focus-visible:ring-0 focus-visible:after:ring-2 focus-visible:after:ring-ring",
  );

  return (
    <div
      className={cn(
        '@container/row flex min-h-[56px] items-center gap-2 px-3 py-2',
        'border-b border-border last:border-b-0',
        extended && 'relative has-[a:active]:bg-surface',
        className,
      )}
      data-testid={testId}
    >
      {href ? (
        <Link className={linkClasses} href={href} prefetch={prefetch} scroll={scroll}>
          {mainContent}
        </Link>
      ) : onActivate ? (
        <button className={cn(linkClasses, 'text-left')} onClick={onActivate} type="button">
          {mainContent}
        </button>
      ) : (
        mainContent
      )}
      {status}
      {primaryAction}
      {extended && overflow ? (
        <div className="relative z-10 flex shrink-0 items-center">{overflow}</div>
      ) : (
        overflow
      )}
    </div>
  );
}
