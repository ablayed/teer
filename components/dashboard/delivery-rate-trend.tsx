'use client';

import { DefinitionToggle } from '@/components/ui/definition-card';
import type { MetricLoadState } from '@/lib/dashboard/metric-load-state';
import type { LossAnalyticsTrendPoint } from '@/lib/loss-analytics/metrics';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type DeliveryRateTrendData = {
  trends: LossAnalyticsTrendPoint[];
};

type DeliveryRateTrendProps = {
  deliveryCountLabel: string;
  definition: string;
  emptyLabel: string;
  errorLabel: string;
  state: MetricLoadState<DeliveryRateTrendData>;
  title: string;
};

function formatPercent(value: number): string {
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0, style: 'percent' }).format(
    value,
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' }).format(
    new Date(`${value}T00:00:00.000Z`),
  );
}

function DeliveryRateTooltip({
  active,
  deliveryCountLabel,
  payload,
}: {
  active?: boolean;
  deliveryCountLabel: string;
  payload?: readonly { payload?: { date: string; deliveredOrders: number; totalOrders: number } }[];
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) {
    return null;
  }

  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 shadow-2">
      <p className="font-mono text-sm font-semibold tabular-nums text-text">
        {formatPercent(point.totalOrders > 0 ? point.deliveredOrders / point.totalOrders : 0)}
      </p>
      <p className="text-xs text-muted">{formatDate(point.date)}</p>
      <p className="mt-1 text-xs text-muted">
        {deliveryCountLabel
          .replace('{delivered}', String(point.deliveredOrders))
          .replace('{total}', String(point.totalOrders))}
      </p>
    </div>
  );
}

// Les cohortes immatures ne sont pas tracées du tout : elles apparaissent
// naturellement, en trait plein, une fois leur seuil de maturité dépassé.
export function selectMatureCohortPoints(
  trends: readonly LossAnalyticsTrendPoint[],
): (LossAnalyticsTrendPoint & { matureRate: number })[] {
  return trends
    .filter((point) => point.isMature)
    .map((point) => ({
      ...point,
      matureRate: point.cohortDeliveryRate,
    }));
}

function TrendChart({
  data,
  deliveryCountLabel,
}: {
  data: DeliveryRateTrendData;
  deliveryCountLabel: string;
}) {
  const chartData = selectMatureCohortPoints(data.trends);

  return (
    <div className="h-[260px] w-full">
      <ResponsiveContainer height="100%" width="100%">
        <AreaChart data={chartData} margin={{ bottom: 0, left: 0, right: 8, top: 8 }}>
          <defs>
            <linearGradient id="deliveryRateMature" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--success)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="var(--success)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" vertical={false} />
          <XAxis
            axisLine={false}
            dataKey="date"
            minTickGap={24}
            tick={{ fill: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
            tickFormatter={formatDate}
            tickLine={false}
          />
          <YAxis
            axisLine={false}
            domain={[0, 1]}
            tick={{ fill: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
            tickFormatter={formatPercent}
            tickLine={false}
            width={44}
          />
          <Tooltip
            content={(props) => (
              <DeliveryRateTooltip
                active={props.active}
                deliveryCountLabel={deliveryCountLabel}
                payload={
                  props.payload as
                    | readonly {
                        payload?: { date: string; deliveredOrders: number; totalOrders: number };
                      }[]
                    | undefined
                }
              />
            )}
            cursor={{ stroke: 'var(--border)', strokeDasharray: '4 4' }}
          />
          <Area
            connectNulls={false}
            dataKey="matureRate"
            fill="url(#deliveryRateMature)"
            isAnimationActive={false}
            stroke="var(--success)"
            strokeWidth={2}
            type="monotone"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DeliveryRateTrend({
  deliveryCountLabel,
  definition,
  emptyLabel,
  errorLabel,
  state,
  title,
}: DeliveryRateTrendProps) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-text">{title}</h2>
        </div>
        <DefinitionToggle definition={definition} />
      </div>
      {state.status === 'ready' ? (
        <TrendChart data={state.data} deliveryCountLabel={deliveryCountLabel} />
      ) : state.status === 'error' ? (
        <div className="flex min-h-[220px] items-center justify-center rounded-md border border-dashed border-danger/30 bg-danger-subtle px-4 text-center text-sm text-danger">
          {errorLabel}
        </div>
      ) : (
        <div className="flex min-h-[220px] items-center justify-center rounded-md border border-dashed border-border bg-canvas px-4 text-center text-sm text-muted">
          {emptyLabel}
        </div>
      )}
    </section>
  );
}
