import { Card } from '@/components/ui/card';
import type { DashboardShopPerformance } from '@/lib/actions/dashboard';
import { cn } from '@/lib/utils';
import { formatDashboardCount, formatDashboardMoney } from './dashboard-format';

type ShopPerformanceProps = {
  currency: string | null;
  emptyLabel: string;
  items: DashboardShopPerformance[];
  title: string;
};

function statusLabel(status: string): string {
  return status === 'connected' ? 'Connectée' : 'À vérifier';
}

export function ShopPerformance({ currency, emptyLabel, items, title }: ShopPerformanceProps) {
  return (
    <Card className="rounded-lg" padding="lg">
      <h2 className="mb-5 text-[15px] font-semibold text-text">{title}</h2>
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
                    {statusLabel(shop.status)}
                  </p>
                </div>
                <p className="font-mono text-sm font-semibold text-text tabular-nums">
                  {formatDashboardMoney(shop.revenue, currency)}
                </p>
              </div>
              <p className="font-mono text-xs text-muted tabular-nums">
                {formatDashboardCount(shop.ordersCount)} commandes
              </p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
