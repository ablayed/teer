import { cn } from '@/lib/utils';

/**
 * Pure — testable sans DOM. Le seuil n'est pas décidé par ce lot, F2b le fixera avec le
 * marchand ; le composant l'accepte en paramètre.
 */
export function hasSufficientVolume(observedCount: number, minimumRequired: number): boolean {
  return observedCount >= minimumRequired;
}

type InsufficientDataStateProps = {
  observedCount: number;
  minimumRequired: number;
  className?: string;
};

/**
 * « Volume insuffisant » est un état distinct de « aucune donnée » (components/ui/empty-state.tsx,
 * réutilisé tel quel pour ce second cas). Un taux calculé sur trois observations ne s'affiche pas —
 * ce composant rend le message à la place ; ne rend rien quand le volume est suffisant, F2 décide
 * alors quoi afficher.
 */
export function InsufficientDataState({
  observedCount,
  minimumRequired,
  className,
}: InsufficientDataStateProps) {
  if (hasSufficientVolume(observedCount, minimumRequired)) {
    return null;
  }

  return (
    <p className={cn('text-sm text-muted', className)} data-testid="insufficient-data-state">
      Pas encore assez de données pour analyser.
    </p>
  );
}
