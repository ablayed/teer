'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type KanbanColumnView = {
  count: number;
  emptyLabel: string;
  id: string;
  title: string;
  tone: 'attention' | 'danger' | 'default' | 'success';
};

type KanbanBoardProps = {
  columns: KanbanColumnView[];
  ariaLabel: string;
};

const toneClasses: Record<KanbanColumnView['tone'], string> = {
  attention: 'border-accent/25 bg-accent-subtle',
  danger: 'border-danger/25 bg-danger-subtle',
  default: 'border-border bg-surface',
  success: 'border-success/25 bg-success-subtle',
};

export function KanbanBoard({ ariaLabel, columns }: KanbanBoardProps) {
  return (
    <section aria-label={ariaLabel} className="space-y-4">
      <div className="overflow-x-auto pb-2">
        <div className="flex min-h-[60vh] gap-4 md:min-w-max">
          {columns.map((column) => (
            <div
              className={cn(
                'flex w-[85vw] shrink-0 flex-col rounded-lg border p-4 shadow-1 md:w-[280px]',
                toneClasses[column.tone],
              )}
              key={column.id}
            >
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="min-w-0 truncate text-sm font-semibold text-text">{column.title}</h2>
                <Badge className="min-w-8 justify-center rounded-full" tone="neutral">
                  {column.count}
                </Badge>
              </div>
              <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border bg-surface/70 px-4 py-8 text-center text-sm text-muted">
                {column.emptyLabel}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
