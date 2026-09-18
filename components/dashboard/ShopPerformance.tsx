import { Card } from '@/components/ui/card';
import type { DashboardShopPerformance } from '@/lib/actions/dashboard';
import type { MetricLoadState } from '@/lib/dashboard/metric-load-state';
import { cn } from '@/lib/utils';
import { formatDashboardCount, formatDashboardMoney } from './dashboard-format';

type ShopPerformanceProps = {
  // Libellé de la colonne monétaire. Le champ reste `revenue` (nom rendu par la RPC
  // get_dashboard_shop_performance et par le type TS) mais la valeur est Σ total_amount de
  // TOUTES les commandes créées sur la période, sans aucun filtre de statut : ce n'est pas
  // un chiffre d'affaires, et le libellé ne doit jamais l'appeler « CA ».
  amountLabel: string;
  currency: string | null;
  connectedLabel: string;
  emptyLabel: string;
  errorLabel: string;
  ordersLabel: string;
  state: MetricLoadState<DashboardShopPerformance[]>;
  subtitle?: string;
  title: string;
  warningLabel: string;
};

export function ShopPerformance({
  amountLabel,
  connectedLabel,
  currency,
  emptyLabel,
  errorLabel,
  ordersLabel,
  state,
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
      {state.status === 'error' ? (
        <p className="rounded-md border border-dashed border-danger/20 bg-danger-subtle p-4 text-sm font-medium text-danger">
          {errorLabel}
        </p>
      ) : state.status === 'ready' ? (
        <div className="space-y-4">
          {state.data.map((shop) => (
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
                <div className="shrink-0 text-right">
                  <p className="font-mono text-sm font-semibold text-text tabular-nums">
                    {formatDashboardMoney(shop.revenue, currency)}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted">{amountLabel}</p>
                </div>
              </div>
              <p className="font-mono text-xs text-muted tabular-nums">
                {formatDashboardCount(shop.ordersCount)} {ordersLabel}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-border bg-canvas p-4 text-sm text-muted">
          {emptyLabel}
        </p>
      )}
    </Card>
  );
}
