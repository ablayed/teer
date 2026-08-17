import type { WorkspaceStore } from '@/lib/workspace/store';
import { Store } from 'lucide-react';
import Link from 'next/link';

/**
 * Choix explicite de la boutique après connexion, pour un utilisateur qui en a
 * plusieurs.
 *
 * Aucune boutique n'est présélectionnée : ni la boutique par défaut, ni la
 * dernière utilisée, ni la première renvoyée par la base. La boutique par défaut
 * est seulement SIGNALÉE, ce qui aide à s'orienter sans décider à la place de
 * l'utilisateur.
 *
 * `section` transporte l'intention de navigation : si la connexion a été
 * déclenchée depuis `/commandes`, le choix mène à `/s/{id}/commandes`. Seule la
 * section est conservée — jamais un identifiant de ressource, qui appartiendrait
 * à une autre boutique.
 */
export function StoreChooser({
  stores,
  section = 'tableau',
}: {
  stores: WorkspaceStore[];
  section?: string;
}) {
  if (stores.length === 0) {
    return (
      <main className="mx-auto flex min-h-[70dvh] w-full max-w-2xl flex-col justify-center gap-4">
        <h1 className="font-display text-4xl">Aucune boutique accessible</h1>
        <p className="text-muted">
          Votre compte n'a accès à aucune boutique pour le moment. Demandez à un propriétaire ou à
          un manager de votre organisation de vous donner accès à une boutique.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-[70dvh] w-full max-w-2xl flex-col justify-center gap-6">
      <div>
        <p className="mb-2 text-sm font-medium text-accent">Espace de travail</p>
        <h1 className="font-display text-4xl">Choisissez une boutique</h1>
        <p className="mt-2 text-muted">
          Les commandes, clients, produits et livreurs seront filtrés par boutique.
        </p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2" data-testid="store-chooser-list">
        {stores.map((store) => (
          <li key={store.id}>
            <Link
              className="flex min-h-16 w-full items-center gap-3 rounded-lg border border-border bg-surface p-4 font-medium shadow-1 transition hover:border-accent hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="store-chooser-option"
              href={`/s/${store.id}/${section}`}
            >
              <Store aria-hidden="true" className="size-5 shrink-0 text-accent" />
              <span className="flex min-w-0 flex-col">
                <span className="min-w-0 truncate" title={store.displayName}>
                  {store.displayName}
                </span>
                {store.isDefault ? (
                  <span className="text-xs font-normal text-muted">Boutique par défaut</span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
