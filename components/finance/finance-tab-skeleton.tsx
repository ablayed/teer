import { AnalyticsSkeleton } from '@/components/ui/analytics-skeleton';

// Skeleton de recalcul streamé pendant que les données d'un onglet Finances se chargent
// (Suspense). Délègue au standard partagé AnalyticsSkeleton (cf. CLAUDE.md « Toute page
// analytique = Suspense + skeleton »).
export function FinanceTabSkeleton() {
  return <AnalyticsSkeleton cards={3} panel />;
}
