'use client';

import * as React from 'react';
import { Tooltip as RechartsTooltip, ResponsiveContainer, type TooltipProps } from 'recharts';

import { cn } from '@/lib/utils';

export type ChartConfig = Record<
  string,
  {
    color?: string;
    icon?: React.ComponentType<{ className?: string }>;
    label?: React.ReactNode;
  }
>;

type ChartContextValue = {
  config: ChartConfig;
};

const ChartContext = React.createContext<ChartContextValue | null>(null);

function getPayloadKey(payload: Record<string, unknown> | undefined): string | null {
  const dataKey = payload?.dataKey;
  const name = payload?.name;

  if (typeof dataKey === 'string' && dataKey.length > 0) {
    return dataKey;
  }

  if (typeof name === 'string' && name.length > 0) {
    return name;
  }

  return null;
}

function getIndicatorColor(
  item: Record<string, unknown>,
  configItem: ChartConfig[string] | undefined,
): string {
  if (typeof configItem?.color === 'string' && configItem.color.length > 0) {
    return configItem.color;
  }

  const fill = item.fill;
  if (typeof fill === 'string' && fill.length > 0) {
    return fill;
  }

  const color = item.color;
  if (typeof color === 'string' && color.length > 0) {
    return color;
  }

  return 'var(--chart-1)';
}

type ChartContainerProps = React.ComponentProps<'div'> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof ResponsiveContainer>['children'];
};

export function ChartContainer({ children, className, config, ...props }: ChartContainerProps) {
  const chartId = React.useId().replace(/:/g, '');
  const style = Object.fromEntries(
    Object.entries(config).flatMap(([key, value]) =>
      value.color ? [[`--color-${key}`, value.color]] : [],
    ),
  ) as React.CSSProperties;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        className={cn(
          'flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted [&_.recharts-cartesian-grid_line[stroke="#ccc"]]:stroke-border [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-layer]:outline-none [&_.recharts-polar-grid_[stroke="#ccc"]]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-canvas [&_.recharts-reference-line_[stroke="#ccc"]]:stroke-border [&_.recharts-sector[stroke="#fff"]]:stroke-transparent [&_.recharts-surface]:outline-none',
          className,
        )}
        data-chart={chartId}
        style={style}
        {...props}
      >
        <ResponsiveContainer>{children}</ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = RechartsTooltip;

type ChartValueType = number | string | Array<number | string>;
type ChartNameType = number | string;

type ChartTooltipContentProps = React.HTMLAttributes<HTMLDivElement> &
  Pick<TooltipProps<ChartValueType, ChartNameType>, 'active' | 'label' | 'payload'> & {
    config?: ChartConfig;
    hideIndicator?: boolean;
    hideLabel?: boolean;
    indicator?: 'dot' | 'line';
    labelFormatter?: (value: React.ReactNode) => React.ReactNode;
    valueFormatter?: (value: ChartValueType, name: string) => React.ReactNode;
  };

export const ChartTooltipContent = React.forwardRef<HTMLDivElement, ChartTooltipContentProps>(
  (
    {
      active,
      className,
      config,
      hideIndicator = false,
      hideLabel = false,
      indicator = 'dot',
      label,
      labelFormatter,
      payload,
      valueFormatter,
    },
    ref,
  ) => {
    const chartContext = React.useContext(ChartContext);
    const resolvedConfig = config ?? chartContext?.config ?? {};

    if (!active || !payload?.length) {
      return null;
    }

    const formattedLabel = labelFormatter ? labelFormatter(label) : label;

    return (
      <div
        className={cn(
          'min-w-[12rem] rounded-md border border-border bg-surface px-3 py-2 text-sm shadow-2',
          className,
        )}
        ref={ref}
      >
        {!hideLabel && formattedLabel ? (
          <p className="mb-2 font-medium text-text">{formattedLabel}</p>
        ) : null}
        <div className="space-y-2">
          {payload.map((entry, index) => {
            const item = entry as Record<string, unknown>;
            const key = getPayloadKey(item);
            const configItem = key ? resolvedConfig[key] : undefined;
            const Icon = configItem?.icon;
            const itemLabel =
              configItem?.label ??
              (typeof item.name === 'string' || typeof item.name === 'number'
                ? String(item.name)
                : (key ?? ''));
            const itemValue = valueFormatter
              ? valueFormatter(entry.value as ChartValueType, String(item.name ?? key ?? ''))
              : entry.value;
            const indicatorColor = getIndicatorColor(item, configItem);

            return (
              <div
                className="flex items-center justify-between gap-3"
                key={`${key ?? 'value'}-${index}`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {Icon ? <Icon className="size-3.5 shrink-0 text-muted" /> : null}
                  {!Icon && !hideIndicator ? (
                    indicator === 'line' ? (
                      <span
                        className="h-2.5 w-0.5 shrink-0 rounded-full"
                        style={{ backgroundColor: indicatorColor }}
                      />
                    ) : (
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: indicatorColor }}
                      />
                    )
                  ) : null}
                  <span className="truncate text-muted">{itemLabel}</span>
                </div>
                <span className="font-mono font-semibold tabular-nums text-text">{itemValue}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  },
);

ChartTooltipContent.displayName = 'ChartTooltipContent';
