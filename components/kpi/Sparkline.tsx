'use client';

import type { KPISparklinePoint } from '@/components/kpi/KPICard';

type SparklineProps = {
  data: KPISparklinePoint[];
  tone?: 'accent' | 'success';
};

const width = 160;
const height = 56;
const padding = 3;

function buildPath(points: KPISparklinePoint[]): string {
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;

  return points
    .map((point, index) => {
      const x = padding + index * step;
      const y = height - padding - ((point.value - min) / range) * (height - padding * 2);

      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

export function Sparkline({ data, tone = 'accent' }: SparklineProps) {
  if (data.length === 0) {
    return null;
  }

  const linePath = buildPath(data);
  const fillPath = `${linePath} L ${width - padding} ${height - padding} L ${padding} ${
    height - padding
  } Z`;
  const stroke = tone === 'success' ? 'var(--success)' : 'var(--accent)';
  const fill = tone === 'success' ? 'var(--success-subtle)' : 'var(--accent-subtle)';

  return (
    <svg
      aria-hidden="true"
      className="h-14 w-full overflow-visible"
      data-testid="kpi-sparkline"
      focusable="false"
      preserveAspectRatio="none"
      viewBox={`0 0 ${width} ${height}`}
    >
      <path d={fillPath} fill={fill} />
      <path d={linePath} fill="none" stroke={stroke} strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}
