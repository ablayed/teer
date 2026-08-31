import { Card } from '@/components/ui/card';
import type { DashboardTopProduct } from '@/lib/actions/dashboard';
import type { MetricLoadState } from '@/lib/dashboard/metric-load-state';
import { formatDashboardCount, formatDashboardMoney } from './dashboard-format';

type TopProductsProps = {
  currency: string | null;
  emptyLabel: string;
  errorLabel: string;
  state: MetricLoadState<DashboardTopProduct[]>;
  subtitle?: string;
  title: string;
  unitsLabel: string;
};

export function TopProducts({
  currency,
  emptyLabel,
  errorLabel,
  state,
  subtitle,
  title,
  unitsLabel,
}: TopProductsProps) {
  return (
    <Card
      className="w-full min-w-0 overflow-hidden rounded-lg"
      data-testid="tableau-top-products-card"
      padding="lg"
    >
      <div className="mb-5">
        <h2 className="text-[15px] font-semibold text-text">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
      </div>
      {state.status === 'error' ? (
        <p className="rounded-md border border-dashed border-danger/20 bg-danger-subtle p-4 text-sm font-medium text-danger">
          {errorLabel}
        </p>
      ) : state.status === 'ready' ? (
        <ol className="space-y-4">
          {state.data.map((item, index) => (
            <li className="grid grid-cols-[auto_1fr] gap-3" key={item.name}>
              <span className="flex size-7 items-center justify-center rounded-sm bg-canvas font-mono text-xs font-semibold text-muted tabular-nums">
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text">{item.name}</p>
                <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted">
                  <span className="font-mono tabular-nums">
                    {formatDashboardCount(item.units)} {unitsLabel}
                  </span>
                  <span className="font-mono tabular-nums text-text">
                    {formatDashboardMoney(item.revenue, currency)}
                  </span>
                </div>
              </div>
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
