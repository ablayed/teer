'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

type ViewMode = 'liste' | 'kanban';

type OrdersViewToggleProps = {
  activeView: ViewMode;
  labelKanban: string;
  labelListe: string;
};

function buildHref(pathname: string, params: URLSearchParams, view: ViewMode): string {
  const nextParams = new URLSearchParams(params);

  if (view === 'liste') {
    nextParams.delete('vue');
  } else {
    nextParams.set('vue', 'kanban');
  }

  const query = nextParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function OrdersViewToggle({ activeView, labelKanban, labelListe }: OrdersViewToggleProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function handleChange(view: ViewMode) {
    const href = buildHref(pathname, new URLSearchParams(searchParams.toString()), view);
    router.replace(href);
  }

  return (
    <div className="inline-flex rounded-md border border-border bg-surface p-1 shadow-1">
      <Button
        aria-pressed={activeView === 'liste'}
        className={cn(
          'min-w-24',
          activeView === 'liste'
            ? 'bg-accent text-accent-ink hover:bg-accent-hover'
            : 'bg-transparent',
        )}
        onClick={() => handleChange('liste')}
        size="sm"
        variant={activeView === 'liste' ? 'primary' : 'ghost'}
      >
        {labelListe}
      </Button>
      <Button
        aria-pressed={activeView === 'kanban'}
        className={cn(
          'min-w-24',
          activeView === 'kanban'
            ? 'bg-accent text-accent-ink hover:bg-accent-hover'
            : 'bg-transparent',
        )}
        onClick={() => handleChange('kanban')}
        size="sm"
        variant={activeView === 'kanban' ? 'primary' : 'ghost'}
      >
        {labelKanban}
      </Button>
    </div>
  );
}
