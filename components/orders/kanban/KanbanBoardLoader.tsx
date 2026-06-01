'use client';

import type { KanbanBoardProps } from '@/components/orders/kanban/KanbanBoard';
import dynamic from 'next/dynamic';

const skeletonColumns = ['one', 'two', 'three', 'four', 'five', 'six'] as const;

function KanbanBoardSkeleton() {
  return (
    <section aria-hidden="true" className="overflow-x-auto pb-2">
      <div className="flex min-h-[60vh] gap-4 md:min-w-max">
        {skeletonColumns.map((column) => (
          <div
            className="flex w-[85vw] shrink-0 flex-col rounded-lg border border-border bg-surface p-4 shadow-1 md:w-[280px]"
            key={column}
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="dashboard-shimmer h-5 w-28 rounded-sm" />
              <div className="dashboard-shimmer h-7 w-8 rounded-full" />
            </div>
            <div className="space-y-3">
              <div className="dashboard-shimmer h-28 rounded-md" />
              <div className="dashboard-shimmer h-28 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const KanbanBoard = dynamic(
  () => import('@/components/orders/kanban/KanbanBoard').then((module) => module.KanbanBoard),
  {
    loading: KanbanBoardSkeleton,
    ssr: false,
  },
);

export function KanbanBoardLoader(props: KanbanBoardProps) {
  return <KanbanBoard {...props} />;
}
