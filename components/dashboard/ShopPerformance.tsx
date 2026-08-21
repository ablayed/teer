import { Card } from '@/components/ui/card';
import type { DashboardShopPerformance } from '@/lib/actions/dashboard';
import { cn } from '@/lib/utils';
import { formatDashboardCount, formatDashboardMoney } from './dashboard-format';

type ShopPerformanceProps = {
  currency: string | null;
  connectedLabel: string;
  emptyLabel: string;
  items: DashboardShopPerformance[];
  ordersLabel: string;
  subtitle?: string;
  title: string;
  warningLabel: string;
};

export function ShopPerformance({
  connectedLabel,
  currency,
  emptyLabel,
  items,
  ordersLabel,
  subtitle,
  title,
  warningLabel,
}: ShopPerformanceProps) {
  return (
    <Card className="min-w-0 rounded-lg" padding="lg">
      <div className="mb-5">
        <h2 className="text-[15px] font-semibold text-text">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
      </div>
      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-canvas p-4 text-sm text-muted">
          {emptyLabel}
        </p>
      ) : (
        <div className="space-y-4">
          {items.map((shop) => (
            <div className="space-y-2" key={shop.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text">{shop.name}</p>
                  <p className="mt-1 flex items-center gap-2 text-xs text-muted">
                    <span
                      className={cn(
                        'size-2 rounded-full',
                        shop.status === 'connected' ? 'bg-success' : 'bg-danger',
                      )}
                    />
                    {shop.status === 'connected' ? connectedLabel : warningLabel}
                  </p>
                </div>
                <p className="font-mono text-sm font-semibold text-text tabular-nums">
                  {formatDashboardMoney(shop.revenue, currency)}
                </p>
              </div>
              <p className="font-mono text-xs text-muted tabular-nums">
                {formatDashboardCount(shop.ordersCount)} {ordersLabel}
              </p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
