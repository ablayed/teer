import type { WorkspaceStore } from '@/lib/workspace/store';
import { ChevronDown, Store } from 'lucide-react';
import Link from 'next/link';

export function StoreContextBar({
  currentStore,
  stores,
}: {
  currentStore: WorkspaceStore;
  stores: WorkspaceStore[];
}) {
  return (
    <div className="mb-4 flex min-h-11 items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2 shadow-1">
      <div className="flex min-w-0 items-center gap-2">
        <Store aria-hidden="true" className="size-4 shrink-0 text-accent" />
        <span className="truncate text-sm font-semibold" title={currentStore.displayName}>
          {currentStore.displayName}
        </span>
      </div>
      {stores.length > 1 ? (
        <details className="relative shrink-0">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-md px-2 text-sm font-medium text-accent hover:bg-canvas [&::-webkit-details-marker]:hidden">
            Changer
            <ChevronDown aria-hidden="true" className="size-4" />
          </summary>
          <div className="absolute right-0 top-full z-50 mt-1 min-w-56 rounded-lg border border-border bg-surface p-1 shadow-warm-2">
            {stores.map((store) => (
              <Link
                className="flex min-h-11 items-center rounded-md px-3 text-sm hover:bg-canvas"
                href={`/s/${store.id}/tableau`}
                key={store.id}
              >
                {store.displayName}
                {store.id === currentStore.id ? ' (actif)' : ''}
              </Link>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
