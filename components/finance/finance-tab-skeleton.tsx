// Skeleton de recalcul streamé pendant que les données d'un onglet Finances
// se chargent (Suspense). Réutilise la classe shimmer du tableau de bord.
export function FinanceTabSkeleton() {
  return (
    <div className="space-y-5" aria-hidden="true">
      <div className="grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div className="dashboard-shimmer h-28 rounded-lg" key={index} />
        ))}
      </div>
      <div className="dashboard-shimmer h-72 rounded-lg" />
    </div>
  );
}
