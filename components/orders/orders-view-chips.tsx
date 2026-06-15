'use client';

import { PendingSpinner } from '@/components/app-shell/pending-spinner';
import type { OrderSavedViewId } from '@/lib/domain/order-saved-views';
import { cn } from '@/lib/utils';

type OrdersViewChipsProps = {
  activeView: OrderSavedViewId;
  onSelect: (viewId: OrderSavedViewId) => void;
  pendingViewId: OrderSavedViewId | null;
  views: Array<{
    count: number;
    id: OrderSavedViewId;
    label: string;
  }>;
};

export function OrdersViewChips({
  activeView,
  onSelect,
  pendingViewId,
  views,
}: OrdersViewChipsProps) {
  return (
    <nav aria-label="Vues commandes" className="flex gap-2 overflow-x-auto pb-1">
      {views.map((view) => {
        const isActive = activeView === view.id;
        const isPending = pendingViewId === view.id;

        return (
          <button
            className={cn(
              'inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium',
              isActive
                ? 'border-accent bg-accent text-[#111]'
                : 'border-border bg-surface text-muted hover:bg-canvas',
            )}
            aria-pressed={isActive}
            key={view.id}
            onClick={() => onSelect(view.id)}
            type="button"
          >
            <span
              className={cn(
                'inline-flex size-3.5 shrink-0 items-center justify-center transition-opacity duration-150',
                isPending ? 'opacity-100' : 'opacity-0',
              )}
            >
              <PendingSpinner className="size-3.5" />
            </span>
            {view.label} ({view.count})
          </button>
        );
      })}
    </nav>
  );
}
