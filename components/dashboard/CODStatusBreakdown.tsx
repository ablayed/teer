import { Card } from '@/components/ui/card';
import { DefinitionToggle } from '@/components/ui/definition-card';
import type { DashboardCodBreakdownItem } from '@/lib/actions/dashboard';
import { type OrderStatus, orderStatusLabels } from '@/lib/domain/order-state-machine';
import { cn } from '@/lib/utils';
import { formatDashboardCount } from './dashboard-format';

type CODStatusBreakdownProps = {
  definition?: string;
  emptyLabel: string;
  items: DashboardCodBreakdownItem[];
  subtitle?: string;
  title: string;
};

const segmentStyles: Record<OrderStatus, string> = {
  A_APPELER: 'bg-accent',
  TENTEE: 'bg-muted',
  CONFIRMEE: 'bg-border',
  PROGRAMMEE: 'bg-border',
  EN_LIVRAISON: 'bg-muted',
  LIVREE: 'bg-success',
  REFUSEE: 'bg-danger',
  ANNULEE: 'bg-danger',
};

export function CODStatusBreakdown({
  definition,
  emptyLabel,
  items,
  subtitle,
  title,
}: CODStatusBreakdownProps) {
  const total = items.reduce((sum, item) => sum + item.count, 0);

  return (
    <Card className="rounded-lg" padding="lg">
      <div className="mb-5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-text">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
        </div>
        {definition ? <DefinitionToggle definition={definition} /> : null}
      </div>
      {total === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-canvas p-4 text-sm text-muted">
          {emptyLabel}
        </p>
      ) : (
        <div className="space-y-5">
          <div className="flex h-3 overflow-hidden rounded-full bg-canvas">
            {items.map((item) =>
              item.count > 0 ? (
                <span
                  aria-label={`${orderStatusLabels[item.status]}: ${item.count}`}
                  className={cn(segmentStyles[item.status])}
                  key={item.status}
                  style={{ width: `${(item.count / total) * 100}%` }}
                />
              ) : null,
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {items.map((item) => (
              <div className="flex items-center gap-2 text-xs" key={item.status}>
                <span className={cn('size-2 rounded-full', segmentStyles[item.status])} />
                <span className="min-w-0 flex-1 truncate text-muted">
                  {orderStatusLabels[item.status]}
                </span>
                <span className="font-mono font-semibold text-text tabular-nums">
                  {formatDashboardCount(item.count)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
