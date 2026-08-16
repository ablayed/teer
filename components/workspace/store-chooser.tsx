import type { WorkspaceStore } from '@/lib/workspace/store';
import { Store } from 'lucide-react';
import Link from 'next/link';

export function StoreChooser({ stores }: { stores: WorkspaceStore[] }) {
  return (
    <main className="mx-auto flex min-h-[70dvh] w-full max-w-2xl flex-col justify-center gap-6">
      <div>
        <p className="mb-2 text-sm font-medium text-accent">Espace de travail</p>
        <h1 className="font-display text-4xl">Choisissez une boutique</h1>
        <p className="mt-2 text-muted">
          Les commandes, clients et produits seront filtrés par boutique.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {stores.map((store) => (
          <Link
            className="flex min-h-16 items-center gap-3 rounded-lg border border-border bg-surface p-4 font-medium shadow-1 transition hover:border-accent hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href={`/s/${store.id}/tableau`}
            key={store.id}
          >
            <Store aria-hidden="true" className="size-5 shrink-0 text-accent" />
            <span className="min-w-0 truncate">{store.displayName}</span>
          </Link>
        ))}
      </div>
    </main>
  );
}
