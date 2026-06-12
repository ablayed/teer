'use client';

import { KanbanCard } from '@/components/orders/kanban/KanbanCard';
import {
  type KanbanColumnKey,
  getKanbanColumnKey,
  groupOrdersByKanbanColumn,
  normalizeOrderStatus,
} from '@/components/orders/kanban/kanban-utils';
import { Badge } from '@/components/ui/badge';
import type { OrderListItem } from '@/lib/actions/orders';
import { performTransition } from '@/lib/actions/transitions';
import type { OrderStatus } from '@/lib/domain/order-state-machine';
import type { TransitionAction } from '@/lib/domain/order-transition-actions';
import { cn } from '@/lib/utils';
import { MotionConfig, motion, useReducedMotion } from 'framer-motion';
import { MoreHorizontal } from 'lucide-react';
import { useAction } from 'next-safe-action/hooks';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

export type KanbanColumnView = {
  count: number;
  emptyLabel: string;
  id: KanbanColumnKey;
  orders: OrderListItem[];
  targetAction?: TransitionAction;
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
  transitionMenu: {
    closed: string;
    label: string;
    move: string;
  };
};

const toneClasses: Record<KanbanColumnView['tone'], string> = {
  attention: 'border-accent/25 bg-accent-subtle',
  danger: 'border-danger/25 bg-danger-subtle',
  default: 'border-border bg-surface',
  success: 'border-success/25 bg-success-subtle',
};

const actionLabels: Record<TransitionAction, string> = {
  journaliser_appel: 'Journaliser une tentative',
  confirmer: 'Confirmer',
  programmer: 'Programmer la livraison',
  assigner: 'Assigner',
  livrer: 'Marquer livree',
  annuler: 'Annuler',
  refuser: 'Refuser',
  deconfirmer: 'Déconfirmer',
  desannuler: 'Désannuler',
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

export function KanbanBoard({ ariaLabel, columns, toasts, transitionMenu }: KanbanBoardProps) {
  const router = useRouter();
  const isDesktop = useIsDesktop();
  const transitionStatus = useAction(performTransition);
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

  async function moveOrderByAction(orderId: string, action: TransitionAction) {
    const order = orders.find((candidate) => candidate.id === orderId);

    if (!order) {
      return;
    }

    if (!order.allowedActions.includes(action)) {
      setToast({ message: toasts.unauthorized, tone: 'danger' });
      return;
    }

    const result = await transitionStatus.executeAsync({ orderId, action });

    if (result?.data?.ok) {
      const newStatus = normalizeOrderStatus(result.data.order.cod_status);
      setToast({ message: toasts.successByStatus[newStatus], tone: 'success' });
      router.refresh();
      return;
    }

    const data = result?.data;
    const message =
      data && 'message' in data && typeof data.message === 'string' ? data.message : toasts.error;
    setToast({ message, tone: 'danger' });
  }

  async function moveOrderToColumn(orderId: string, targetColumn: KanbanColumnView) {
    const order = orders.find((candidate) => candidate.id === orderId);

    if (!order) {
      return;
    }

    const from = normalizeOrderStatus(order.cod_status);

    if (from === targetColumn.targetStatus || getKanbanColumnKey(from) === targetColumn.id) {
      return;
    }

    if (!targetColumn.targetAction) {
      setToast({ message: toasts.unauthorized, tone: 'danger' });
      return;
    }

    await moveOrderByAction(orderId, targetColumn.targetAction);
  }

  return (
    <MotionConfig reducedMotion="user">
      <section aria-label={ariaLabel} className="space-y-4">
        {isDesktop ? (
          <DesktopKanbanBoard columns={visibleColumns} onMoveOrder={moveOrderToColumn} />
        ) : (
          <StaticKanbanBoard
            columns={visibleColumns}
            onMoveOrder={moveOrderByAction}
            transitionMenu={transitionMenu}
          />
        )}
        <KanbanToast message={toast?.message ?? null} tone={toast?.tone ?? 'success'} />
      </section>
    </MotionConfig>
  );
}

function MobileTransitionMenu({
  labels,
  onMoveOrder,
  order,
}: {
  labels: KanbanBoardProps['transitionMenu'];
  onMoveOrder: (orderId: string, action: TransitionAction) => Promise<void>;
  order: OrderListItem;
}) {
  const [open, setOpen] = useState(false);

  if (order.allowedActions.length === 0) {
    return (
      <Badge className="rounded-full" tone="neutral">
        {labels.closed}
      </Badge>
    );
  }

  return (
    <div className="relative">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={labels.move}
        className="inline-flex size-11 items-center justify-center rounded-md border border-border bg-surface text-text shadow-1 hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <MoreHorizontal aria-hidden="true" className="size-5" />
      </button>
      {open ? (
        <div
          aria-label={labels.label}
          className="absolute top-12 right-0 z-30 w-52 rounded-md border border-border bg-surface p-1 shadow-2"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setOpen(false);
            }
          }}
          role="menu"
        >
          {order.allowedActions.map((action) => (
            <button
              className="flex min-h-11 w-full items-center rounded-sm px-3 text-left text-sm text-text hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              key={action}
              onClick={async () => {
                setOpen(false);
                await onMoveOrder(order.id, action);
              }}
              role="menuitem"
              type="button"
            >
              {actionLabels[action]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StaticKanbanBoard({
  columns,
  onMoveOrder,
  transitionMenu,
}: {
  columns: KanbanColumnView[];
  onMoveOrder: (orderId: string, action: TransitionAction) => Promise<void>;
  transitionMenu: KanbanBoardProps['transitionMenu'];
}) {
  const reduceMotion = useReducedMotion();

  return (
    <div className="overflow-x-auto pb-2">
      <motion.div
        className="flex min-h-[60vh] gap-4 md:min-w-max"
        initial={reduceMotion ? false : 'hidden'}
        animate="visible"
        variants={{
          hidden: {},
          visible: {
            transition: {
              staggerChildren: reduceMotion ? 0 : 0.06,
            },
          },
        }}
      >
        {columns.map((column) => (
          <motion.div
            className={cn(
              'flex w-[85vw] shrink-0 flex-col rounded-lg border p-4 shadow-1 md:w-[280px]',
              column.toneClassName,
            )}
            key={column.id}
            variants={{
              hidden: { opacity: 0, y: 8 },
              visible: { opacity: 1, y: 0, transition: { duration: 0.28 } },
            }}
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
                  <motion.div
                    key={order.id}
                    layout={!reduceMotion}
                    transition={{ duration: reduceMotion ? 0 : 0.2 }}
                    whileHover={reduceMotion ? undefined : { y: -2 }}
                  >
                    <KanbanCard
                      actions={
                        <MobileTransitionMenu
                          labels={transitionMenu}
                          onMoveOrder={onMoveOrder}
                          order={order}
                        />
                      }
                      emptyLabel={column.emptyLabel}
                      order={order}
                    />
                  </motion.div>
                ))}
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border bg-surface/70 px-4 py-8 text-center text-sm text-muted">
                {column.emptyLabel}
              </div>
            )}
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
