'use client';

import type {
  FinanceDriverOutstanding,
  FinanceShortfall,
} from '@/components/finance/DriverSettlementsPanel';
import dynamic from 'next/dynamic';

const DriverSettlementsPanel = dynamic(
  () =>
    import('@/components/finance/DriverSettlementsPanel').then((mod) => mod.DriverSettlementsPanel),
  {
    loading: () => (
      <section className="h-72 animate-pulse rounded-lg border border-border bg-surface shadow-1" />
    ),
    ssr: false,
  },
);

export function DriverSettlementsLoader({
  currentRole,
  drivers,
  scopeNote,
  shortfalls,
}: {
  currentRole: string;
  drivers: FinanceDriverOutstanding[];
  scopeNote?: string;
  shortfalls: FinanceShortfall[];
}) {
  return (
    <DriverSettlementsPanel
      currentRole={currentRole}
      drivers={drivers}
      scopeNote={scopeNote}
      shortfalls={shortfalls}
    />
  );
}
