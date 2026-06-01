import { Card } from '@/components/ui/card';
import type { DashboardTopProduct } from '@/lib/actions/dashboard';
import { formatDashboardCount, formatDashboardMoney } from './dashboard-format';

type TopProductsProps = {
  currency: string | null;
  emptyLabel: string;
  items: DashboardTopProduct[];
  title: string;
  unitsLabel: string;
};

export function TopProducts({ currency, emptyLabel, items, title, unitsLabel }: TopProductsProps) {
  return (
    <Card className="rounded-lg" padding="lg">
      <h2 className="mb-5 text-[15px] font-semibold text-text">{title}</h2>
      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-canvas p-4 text-sm text-muted">
          {emptyLabel}
        </p>
      ) : (
        <ol className="space-y-3">
          {items.map((item, index) => (
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
      )}
    </Card>
  );
}
