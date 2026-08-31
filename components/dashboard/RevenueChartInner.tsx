'use client';

import type { DashboardRevenue30d } from '@/lib/actions/dashboard';
import type { MetricLoadState } from '@/lib/dashboard/metric-load-state';
import { formatFCFA } from '@/lib/format/fcfa';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type RevenueChartInnerProps = {
  currency: string | null;
  emptyLabel: string;
  errorLabel: string;
  state: MetricLoadState<DashboardRevenue30d>;
  title: string;
};

type TooltipPayload = {
  payload?: {
    date: string;
    value: number;
  };
};

function formatCompact(value: number): string {
  return new Intl.NumberFormat('fr-FR', {
    compactDisplay: 'short',
    maximumFractionDigits: 1,
    notation: 'compact',
  }).format(value);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'short',
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function RevenueTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: readonly TooltipPayload[];
}) {
  const point = payload?.[0]?.payload;

  if (!active || !point) {
    return null;
  }

  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 shadow-2">
      <p className="font-mono text-sm font-semibold tabular-nums text-text">
        {formatFCFA(point.value)}
      </p>
      <p className="text-xs text-muted">{formatDate(point.date)}</p>
    </div>
  );
}

export default function RevenueChartInner({
  emptyLabel,
  errorLabel,
  state,
  title,
}: RevenueChartInnerProps) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-text">{title}</h2>
        <span className="font-mono text-xs text-muted tabular-nums">30 j</span>
      </div>

      {state.status === 'ready' ? (
        <div className="h-[260px] w-full">
          <ResponsiveContainer height="100%" width="100%">
            <AreaChart data={state.data.points} margin={{ bottom: 0, left: 0, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="revenueGradient" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
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
                tick={{ fill: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}
                tickFormatter={formatCompact}
                tickLine={false}
                width={44}
              />
              <Tooltip
                content={(props) => (
                  <RevenueTooltip
                    active={props.active}
                    payload={props.payload as readonly TooltipPayload[] | undefined}
                  />
                )}
                cursor={{ stroke: 'var(--border)', strokeDasharray: '4 4' }}
              />
              <Area
                dataKey="value"
                fill="url(#revenueGradient)"
                isAnimationActive={false}
                stroke="var(--accent)"
                strokeWidth={2}
                type="monotone"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
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
