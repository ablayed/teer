'use client';

import type { KanbanBoardProps } from '@/components/orders/kanban/KanbanBoard';
import dynamic from 'next/dynamic';

const KanbanBoard = dynamic(
  () => import('@/components/orders/kanban/KanbanBoard').then((module) => module.KanbanBoard),
  {
    ssr: false,
  },
);

export function KanbanBoardLoader(props: KanbanBoardProps) {
  return <KanbanBoard {...props} />;
}
