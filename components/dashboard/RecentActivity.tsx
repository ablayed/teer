import { Card } from '@/components/ui/card';
import type { DashboardRecentActivityItem } from '@/lib/actions/dashboard';
import type { MetricLoadState } from '@/lib/dashboard/metric-load-state';
import { orderStatusLabels } from '@/lib/domain/order-state-machine';
import { formatDateRelative } from '@/lib/format/date';
import { formatOrderNumber } from './dashboard-format';

type RecentActivityProps = {
  emptyLabel: string;
  errorLabel: string;
  initialLabel: string;
  orderFallbackLabel: string;
  state: MetricLoadState<DashboardRecentActivityItem[]>;
  title: string;
};

export function RecentActivity({
  emptyLabel,
  errorLabel,
  initialLabel,
  orderFallbackLabel,
  state,
  title,
}: RecentActivityProps) {
  return (
    <Card className="rounded-lg" padding="lg">
      <h2 className="mb-5 text-[15px] font-semibold text-text">{title}</h2>
      {state.status === 'error' ? (
        <p className="rounded-md border border-dashed border-danger/20 bg-danger-subtle p-4 text-sm font-medium text-danger">
          {errorLabel}
        </p>
      ) : state.status === 'ready' ? (
        <ol className="space-y-4">
          {state.data.map((item) => (
            <li className="relative border-l border-border pl-4" key={item.id}>
              <span className="-left-[5px] absolute top-1.5 size-2 rounded-full bg-accent" />
              <p className="text-sm font-medium text-text">
                {formatOrderNumber(item.orderNumber, orderFallbackLabel)} ·{' '}
                {item.fromStatus ? orderStatusLabels[item.fromStatus] : initialLabel} →{' '}
                {orderStatusLabels[item.toStatus]}
              </p>
              <p className="mt-1 font-mono text-xs text-muted tabular-nums">
                {formatDateRelative(item.createdAt)}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rounded-md border border-dashed border-border bg-canvas p-4 text-sm text-muted">
          {emptyLabel}
        </p>
      )}
    </Card>
  );
}
