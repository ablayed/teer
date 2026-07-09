'use client';

import { ResponsiveBarChart } from '@/components/charts/responsive-bar-chart';
import { Card } from '@/components/ui/card';
import type {
  DashboardCashCollectedByProduct,
  DashboardDeliveriesByProduct,
} from '@/lib/actions/dashboard';
import { formatMoney } from '@/lib/format/fcfa';
import { formatDashboardCount } from './dashboard-format';

type TableauCashCollectedCardProps = {
  emptyLabel: string;
  title: string;
  valueMinor: number;
};

type TableauCashByProductChartProps = {
  chart: DashboardCashCollectedByProduct;
  emptyLabel: string;
  subtitle: string;
  title: string;
};

type TableauDeliveriesCardProps = {
  deliveries: DashboardDeliveriesByProduct;
  emptyLabel: string;
  subtitle: string;
  title: string;
  totalLabel: string;
};

function EmptyState({ label }: { label: string }) {
  return (
    <p className="rounded-md border border-dashed border-border bg-canvas p-4 text-sm text-muted">
      {label}
    </p>
  );
}

function compactCount(value: number): string {
  return new Intl.NumberFormat('fr-FR', {
    compactDisplay: 'short',
    maximumFractionDigits: 1,
    notation: 'compact',
  }).format(value);
}

export function TableauCashCollectedCard({
  emptyLabel,
  title,
  valueMinor,
}: TableauCashCollectedCardProps) {
  return (
    <Card className="rounded-lg" padding="lg">
      <div className="mb-5">
        <h2 className="text-[15px] font-semibold text-text">{title}</h2>
      </div>
      {valueMinor > 0 ? (
        <p className="font-mono text-3xl font-semibold tabular-nums text-text">
          {formatMoney(valueMinor)}
        </p>
      ) : (
        <EmptyState label={emptyLabel} />
      )}
    </Card>
  );
}

export function TableauCashByProductChart({
  chart,
  emptyLabel,
  subtitle,
  title,
}: TableauCashByProductChartProps) {
  const hasData = chart.items.some((item) => item.revenueMinor > 0);

  return (
    <Card className="rounded-lg" data-testid="tableau-cash-by-product-card" padding="lg">
      <div className="mb-5">
        <h2 className="text-[15px] font-semibold text-text">{title}</h2>
        <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
      </div>
      {hasData ? (
        <ResponsiveBarChart
          ariaLabel={`${title}. ${subtitle}`}
          axisValueFormatter={(value) => compactCount(value)}
          color="var(--chart-1)"
          data={chart.items.map((item) => ({
            category: item.title,
            value: item.revenueMinor,
          }))}
          dataTestId="tableau-cash-by-product-chart"
          tooltipValueFormatter={(value) => formatMoney(value)}
          valueLabel={title}
        />
      ) : (
        <EmptyState label={emptyLabel} />
      )}
    </Card>
  );
}

export function TableauDeliveriesCard({
  deliveries,
  emptyLabel,
  subtitle,
  title,
  totalLabel,
}: TableauDeliveriesCardProps) {
  return (
    <Card className="rounded-lg" padding="lg">
      <div className="mb-5">
        <h2 className="text-[15px] font-semibold text-text">{title}</h2>
        <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
      </div>
      <div className="mb-5 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-muted">{totalLabel}</p>
          <p className="font-mono text-3xl font-semibold tabular-nums text-text">
            {formatDashboardCount(deliveries.totalDeliveries)}
          </p>
        </div>
      </div>
      {deliveries.products.length === 0 ? (
        <EmptyState label={emptyLabel} />
      ) : (
        <ol className="space-y-3">
          {deliveries.products.map((item, index) => (
            <li className="grid grid-cols-[auto_1fr] gap-3" key={item.productId}>
              <span className="flex size-7 items-center justify-center rounded-sm bg-canvas font-mono text-xs font-semibold text-muted tabular-nums">
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text">{item.title}</p>
                <p className="mt-1 font-mono text-xs tabular-nums text-muted">
                  {formatDashboardCount(item.deliveredOrdersCount)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
