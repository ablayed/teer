// Standard PARTAGÉ — squelette streamé d'une section analytique (cartes KPI + panneau/graphe).
// Toute page ou onglet analytique enveloppe ses données lourdes dans
//   <Suspense fallback={<AnalyticsSkeleton .../>} key={...}> … </Suspense>
// pour que le changement de filtre/onglet (searchParam, qui NE déclenche PAS loading.tsx)
// rende immédiatement un état de chargement au lieu de geler l'ancienne vue.
// Voir CLAUDE.md « Toute page analytique = Suspense + skeleton ». Réutilise la classe
// `dashboard-shimmer` (animation déjà définie globalement).
export function AnalyticsSkeleton({
  cards = 3,
  panel = true,
}: {
  cards?: number;
  panel?: boolean;
}) {
  return (
    <div className="space-y-5" aria-hidden="true">
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
        {Array.from({ length: cards }, (_, index) => index).map((cardKey) => (
          <div className="dashboard-shimmer h-28 rounded-lg" key={cardKey} />
        ))}
      </div>
      {panel ? <div className="dashboard-shimmer h-72 rounded-lg" /> : null}
    </div>
  );
}
