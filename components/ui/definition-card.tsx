'use client';

import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';

// Card « à définition » partagée : un libellé marchand + une explication en langage
// simple révélée AU TAP (pas au survol — mobile-first). Deux variantes :
//  - DefinitionCard : card valeur autonome (toute la card est tappable).
//  - DefinitionToggle : juste l'affordance + le panneau, à embarquer dans une card
//    plus riche (KPICard animé, en-tête de bloc) sans perdre son contenu existant.

function DefinitionPanel({ definition, formula }: { definition: string; formula?: string }) {
  return (
    <div className="mt-3 rounded-md border border-border bg-canvas p-3 text-left">
      <p className="text-sm text-text">{definition}</p>
      {formula ? (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs leading-5 text-muted">
          {formula}
        </pre>
      ) : null}
    </div>
  );
}

export function DefinitionToggle({
  definition,
  formula,
}: {
  definition: string;
  formula?: string;
}) {
  const t = useTranslations('definitionCard');
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        aria-expanded={open}
        className="inline-flex min-h-9 items-center gap-1 rounded-full border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-canvas hover:text-text"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {open ? t('hide') : t('show')}
      </button>
      {open ? <DefinitionPanel definition={definition} formula={formula} /> : null}
    </div>
  );
}

export function DefinitionCard({
  definition,
  description,
  formula,
  label,
  value,
}: {
  definition: string;
  description?: string;
  formula?: string;
  label: string;
  // Valeur déjà formatée (FCFA via <Amount>, %, compte…) — la card est générique.
  value: ReactNode;
}) {
  const t = useTranslations('definitionCard');
  const [open, setOpen] = useState(false);

  return (
    <button
      aria-expanded={open}
      className="rounded-lg border border-border bg-surface p-4 text-left shadow-1 transition hover:-translate-y-0.5 hover:shadow-2 md:p-5"
      onClick={() => setOpen((current) => !current)}
      type="button"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium text-muted">{label}</p>
          <p className="mt-2 font-mono text-2xl font-semibold tabular-nums md:text-3xl">{value}</p>
          {description ? <p className="mt-2 text-sm text-muted">{description}</p> : null}
        </div>
        <span className="shrink-0 rounded-full border border-border px-2 py-1 text-[11px] font-medium text-muted">
          {open ? t('hide') : t('show')}
        </span>
      </div>
      {open ? <DefinitionPanel definition={definition} formula={formula} /> : null}
    </button>
  );
}
