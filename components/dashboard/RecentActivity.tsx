import { Card } from '@/components/ui/card';
import type { DashboardRecentActivityItem } from '@/lib/actions/dashboard';
import { orderStatusLabels } from '@/lib/domain/order-state-machine';
import { formatDateRelative } from '@/lib/format/date';
import { formatOrderNumber } from './dashboard-format';

type RecentActivityProps = {
  emptyLabel: string;
  items: DashboardRecentActivityItem[];
  title: string;
};

export function RecentActivity({ emptyLabel, items, title }: RecentActivityProps) {
  return (
    <Card className="rounded-lg" padding="lg">
      <h2 className="mb-5 text-[15px] font-semibold text-text">{title}</h2>
      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-canvas p-4 text-sm text-muted">
          {emptyLabel}
        </p>
      ) : (
        <ol className="space-y-4">
          {items.map((item) => (
            <li className="relative border-l border-border pl-4" key={item.id}>
              <span className="-left-[5px] absolute top-1.5 size-2 rounded-full bg-accent" />
              <p className="text-sm font-medium text-text">
                {formatOrderNumber(item.orderNumber)} ·{' '}
                {item.fromStatus ? orderStatusLabels[item.fromStatus] : 'Initial'} →{' '}
                {orderStatusLabels[item.toStatus]}
              </p>
              <p className="mt-1 font-mono text-xs text-muted tabular-nums">
                {formatDateRelative(item.createdAt)}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
