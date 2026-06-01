'use client';

import { KanbanCard } from '@/components/orders/kanban/KanbanCard';
import {
  type KanbanColumnKey,
  getKanbanColumnKey,
  groupOrdersByKanbanColumn,
  normalizeOrderStatus,
} from '@/components/orders/kanban/kanban-utils';
import { Badge } from '@/components/ui/badge';
import { type OrderListItem, transitionOrderStatusAction } from '@/lib/actions/orders';
import { type OrderStatus, canTransition } from '@/lib/domain/order-state-machine';
import { cn } from '@/lib/utils';
import { useAction } from 'next-safe-action/hooks';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

export type KanbanColumnView = {
  count: number;
  emptyLabel: string;
  id: KanbanColumnKey;
  orders: OrderListItem[];
  targetStatus: OrderStatus;
  title: string;
  tone: 'attention' | 'danger' | 'default' | 'success';
  toneClassName?: string;
};

export type KanbanBoardProps = {
  ariaLabel: string;
  columns: KanbanColumnView[];
  toasts: {
    error: string;
    successByStatus: Record<OrderStatus, string>;
    unauthorized: string;
  };
};

const toneClasses: Record<KanbanColumnView['tone'], string> = {
  attention: 'border-accent/25 bg-accent-subtle',
  danger: 'border-danger/25 bg-danger-subtle',
  default: 'border-border bg-surface',
  success: 'border-success/25 bg-success-subtle',
};

const DesktopKanbanBoard = dynamic(
  () =>
    import('@/components/orders/kanban/KanbanDesktopBoard').then(
      (module) => module.KanbanDesktopBoard,
    ),
  {
    ssr: false,
  },
);

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(min-width: 768px)');

    function handleChange() {
      setIsDesktop(mediaQuery.matches);
    }

    handleChange();
    mediaQuery.addEventListener('change', handleChange);

    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return isDesktop;
}

function createColumns(configs: KanbanColumnView[], orders: OrderListItem[]): KanbanColumnView[] {
  const groupedOrders = groupOrdersByKanbanColumn(orders);

  return configs.map((column) => {
    const columnOrders = groupedOrders[column.id];

    return {
      ...column,
      count: columnOrders.length,
      orders: columnOrders,
      toneClassName: toneClasses[column.tone],
    };
  });
}

function KanbanToast({
  message,
  tone,
}: {
  message: string | null;
  tone: 'danger' | 'success';
}) {
  if (!message) {
    return null;
  }

  return (
    <div
      className={cn(
        'fixed right-4 bottom-24 z-50 max-w-sm rounded-md border bg-surface px-4 py-3 text-sm font-medium shadow-2 md:bottom-6',
        tone === 'danger' ? 'border-danger/30 text-danger' : 'border-success/30 text-success',
      )}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      {message}
    </div>
  );
}

export function KanbanBoard({ ariaLabel, columns, toasts }: KanbanBoardProps) {
  const router = useRouter();
  const isDesktop = useIsDesktop();
  const transitionStatus = useAction(transitionOrderStatusAction);
  const initialOrders = useMemo(() => columns.flatMap((column) => column.orders), [columns]);
  const [orders, setOrders] = useState(initialOrders);
  const [toast, setToast] = useState<{ message: string; tone: 'danger' | 'success' } | null>(null);
  const visibleColumns = useMemo(() => createColumns(columns, orders), [columns, orders]);

  useEffect(() => {
    setOrders(initialOrders);
  }, [initialOrders]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeoutId = window.setTimeout(() => setToast(null), 3000);

    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  async function moveOrder(orderId: string, targetColumn: KanbanColumnView) {
    const order = orders.find((candidate) => candidate.id === orderId);

    if (!order) {
      return;
    }

    const from = normalizeOrderStatus(order.cod_status);
    const to = targetColumn.targetStatus;

    if (from === to || getKanbanColumnKey(from) === targetColumn.id) {
      return;
    }

    if (!canTransition(from, to)) {
      setToast({ message: toasts.unauthorized, tone: 'danger' });
      return;
    }

    setOrders((currentOrders) =>
      currentOrders.map((candidate) =>
        candidate.id === orderId ? { ...candidate, cod_status: to } : candidate,
      ),
    );

    const result = await transitionStatus.executeAsync({ orderId, to });

    if (result?.data?.ok) {
      setToast({ message: toasts.successByStatus[result.data.newStatus], tone: 'success' });
      router.refresh();
      return;
    }

    setOrders((currentOrders) =>
      currentOrders.map((candidate) =>
        candidate.id === orderId ? { ...candidate, cod_status: from } : candidate,
      ),
    );

    const data = result?.data;
    const message =
      data && 'message' in data && typeof data.message === 'string' ? data.message : toasts.error;
    setToast({ message, tone: 'danger' });
  }

  return (
    <section aria-label={ariaLabel} className="space-y-4">
      {isDesktop ? (
        <DesktopKanbanBoard columns={visibleColumns} onMoveOrder={moveOrder} />
      ) : (
        <StaticKanbanBoard columns={visibleColumns} />
      )}
      <KanbanToast message={toast?.message ?? null} tone={toast?.tone ?? 'success'} />
    </section>
  );
}

function StaticKanbanBoard({ columns }: { columns: KanbanColumnView[] }) {
  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex min-h-[60vh] gap-4 md:min-w-max">
        {columns.map((column) => (
          <div
            className={cn(
              'flex w-[85vw] shrink-0 flex-col rounded-lg border p-4 shadow-1 md:w-[280px]',
              column.toneClassName,
            )}
            key={column.id}
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="min-w-0 truncate text-sm font-semibold text-text">{column.title}</h2>
              <Badge className="min-w-8 justify-center rounded-full" tone="neutral">
                {column.count}
              </Badge>
            </div>
            {column.orders.length > 0 ? (
              <div className="flex flex-1 flex-col gap-3">
                {column.orders.map((order) => (
                  <KanbanCard emptyLabel={column.emptyLabel} key={order.id} order={order} />
                ))}
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border bg-surface/70 px-4 py-8 text-center text-sm text-muted">
                {column.emptyLabel}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
