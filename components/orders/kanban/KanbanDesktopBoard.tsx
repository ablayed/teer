'use client';

import type { KanbanColumnView } from '@/components/orders/kanban/KanbanBoard';
import { KanbanCard } from '@/components/orders/kanban/KanbanCard';
import { normalizeOrderStatus } from '@/components/orders/kanban/kanban-utils';
import { Badge } from '@/components/ui/badge';
import { canTransition, isTerminal } from '@/lib/domain/order-state-machine';
import { cn } from '@/lib/utils';
import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { motion, useReducedMotion } from 'framer-motion';
import type { CSSProperties } from 'react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

type KanbanDesktopBoardProps = {
  columns: KanbanColumnView[];
  onMoveOrder: (orderId: string, column: KanbanColumnView) => Promise<void>;
};

type SortableKanbanCardProps = {
  emptyLabel: string;
  order: KanbanColumnView['orders'][number];
};

function findColumnForDroppable(
  droppableId: string | null | undefined,
  columns: KanbanColumnView[],
): KanbanColumnView | null {
  if (!droppableId) {
    return null;
  }

  const directColumn = columns.find((column) => column.id === droppableId);

  if (directColumn) {
    return directColumn;
  }

  return columns.find((column) => column.orders.some((order) => order.id === droppableId)) ?? null;
}

function SortableKanbanCard({ emptyLabel, order }: SortableKanbanCardProps) {
  const reduceMotion = useReducedMotion();
  const currentStatus = normalizeOrderStatus(order.cod_status);
  const disabled = isTerminal(currentStatus);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    disabled,
    id: order.id,
  });
  const style: CSSProperties = {
    opacity: isDragging ? 0.35 : 1,
    transform: transform
      ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0) scaleX(${
          transform.scaleX
        }) scaleY(${transform.scaleY})`
      : undefined,
    transition: reduceMotion ? undefined : transition,
  };

  return (
    <motion.div
      className={cn(disabled ? 'cursor-default' : 'cursor-grab active:cursor-grabbing')}
      data-disabled={disabled ? 'true' : undefined}
      layout={!reduceMotion}
      ref={setNodeRef}
      style={style}
      transition={{ duration: reduceMotion ? 0 : 0.2 }}
      whileHover={reduceMotion ? undefined : { y: -2 }}
      {...attributes}
      {...listeners}
    >
      <KanbanCard emptyLabel={emptyLabel} order={order} />
    </motion.div>
  );
}

function DroppableColumn({
  activeOrder,
  children,
  column,
  overColumnId,
}: {
  activeOrder: KanbanColumnView['orders'][number] | null;
  children: ReactNode;
  column: KanbanColumnView;
  overColumnId: string | null;
}) {
  const { setNodeRef } = useDroppable({ id: column.id });
  const isOver = overColumnId === column.id;
  const transitionAllowed =
    activeOrder && canTransition(normalizeOrderStatus(activeOrder.cod_status), column.targetStatus);

  return (
    <div
      className={cn(
        'flex w-[280px] shrink-0 flex-col rounded-lg border p-4 shadow-1 transition duration-200',
        column.toneClassName,
        isOver && transitionAllowed && 'border-accent/40 bg-accent-subtle',
        isOver && !transitionAllowed && 'border-danger/40 bg-danger-subtle',
      )}
      ref={setNodeRef}
    >
      {children}
    </div>
  );
}

export function KanbanDesktopBoard({ columns, onMoveOrder }: KanbanDesktopBoardProps) {
  const reduceMotion = useReducedMotion();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [overColumnId, setOverColumnId] = useState<string | null>(null);
  const activeOrder = useMemo(
    () => columns.flatMap((column) => column.orders).find((order) => order.id === activeOrderId),
    [activeOrderId, columns],
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveOrderId(String(event.active.id));
  }

  function handleDragOver(event: DragOverEvent) {
    setOverColumnId(findColumnForDroppable(String(event.over?.id ?? ''), columns)?.id ?? null);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const orderId = String(event.active.id);
    const targetColumn = findColumnForDroppable(String(event.over?.id ?? ''), columns);

    setActiveOrderId(null);
    setOverColumnId(null);

    if (!targetColumn) {
      return;
    }

    await onMoveOrder(orderId, targetColumn);
  }

  function handleDragCancel() {
    setActiveOrderId(null);
    setOverColumnId(null);
  }

  return (
    <DndContext
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragStart={handleDragStart}
      sensors={sensors}
    >
      <div className="overflow-x-auto pb-2">
        <motion.div
          className="flex min-h-[60vh] gap-4 md:min-w-max"
          animate="visible"
          initial={reduceMotion ? false : 'hidden'}
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
              key={column.id}
              variants={{
                hidden: { opacity: 0, y: 8 },
                visible: { opacity: 1, y: 0, transition: { duration: 0.28 } },
              }}
            >
              <DroppableColumn
                activeOrder={activeOrder ?? null}
                column={column}
                overColumnId={overColumnId}
              >
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h2 className="min-w-0 truncate text-sm font-semibold text-text">
                    {column.title}
                  </h2>
                  <Badge className="min-w-8 justify-center rounded-full" tone="neutral">
                    {column.count}
                  </Badge>
                </div>
                {column.orders.length > 0 ? (
                  <div className="flex flex-1 flex-col gap-3">
                    {column.orders.map((order) => (
                      <SortableKanbanCard
                        emptyLabel={column.emptyLabel}
                        key={order.id}
                        order={order}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border bg-surface/70 px-4 py-8 text-center text-sm text-muted">
                    {column.emptyLabel}
                  </div>
                )}
              </DroppableColumn>
            </motion.div>
          ))}
        </motion.div>
      </div>
      <DragOverlay>
        {activeOrder ? (
          <KanbanCard emptyLabel="" isOverlay={!reduceMotion} order={activeOrder} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
