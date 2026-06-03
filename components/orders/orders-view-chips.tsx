'use client';

import { cn } from '@/lib/utils';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

type OrdersViewChipsProps = {
  activeView: string;
  views: Array<{
    count: number;
    id: string;
    label: string;
  }>;
};

export function OrdersViewChips({ activeView, views }: OrdersViewChipsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function handleSelect(viewId: string) {
    const nextParams = new URLSearchParams(searchParams.toString());

    if (viewId === 'toutes') {
      nextParams.delete('vue');
    } else {
      nextParams.set('vue', viewId);
    }

    const query = nextParams.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <nav aria-label="Vues commandes" className="flex gap-2 overflow-x-auto pb-1">
      {views.map((view) => {
        const isActive = activeView === view.id;

        return (
          <button
            className={cn(
              'inline-flex min-h-11 shrink-0 items-center rounded-full border px-4 text-sm font-medium',
              isActive
                ? 'border-accent bg-accent text-[#111]'
                : 'border-border bg-surface text-muted hover:bg-canvas',
            )}
            key={view.id}
            onClick={() => handleSelect(view.id)}
            type="button"
          >
            {view.label} ({view.count})
          </button>
        );
      })}
    </nav>
  );
}
