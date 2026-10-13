'use client';

import { PendingSpinner } from '@/components/app-shell/pending-spinner';
import type { OrderSavedViewId } from '@/lib/domain/order-saved-views';
import { type ViewCountsStatus, formatViewChipLabel } from '@/lib/orders/deferred-view-counts';
import { cn } from '@/lib/utils';

type OrdersViewChipsProps = {
  activeView: OrderSavedViewId;
  // L04 : les compteurs peuvent arriver après la liste. Défaut : connus.
  countsStatus?: ViewCountsStatus;
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
  countsStatus = 'ready',
  onSelect,
  pendingViewId,
  views,
}: OrdersViewChipsProps) {
  return (
    <nav
      aria-busy={countsStatus === 'pending' ? true : undefined}
      aria-label="Vues commandes"
      className="flex gap-2 overflow-x-auto pb-1"
      data-counts-status={countsStatus}
    >
      {views.map((view) => {
        const isActive = activeView === view.id;
        const isPending = pendingViewId === view.id;

        return (
          <button
            className={cn(
              'inline-flex min-h-12 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium',
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
            {formatViewChipLabel(view.label, view.count, countsStatus)}
          </button>
        );
      })}
    </nav>
  );
}
