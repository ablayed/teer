'use client';

import type { FinanceSettingsValues } from '@/components/finance/FinanceSettingsPanel';
import dynamic from 'next/dynamic';

const FinanceSettingsPanel = dynamic(
  () => import('@/components/finance/FinanceSettingsPanel').then((mod) => mod.FinanceSettingsPanel),
  {
    loading: () => (
      <section className="h-72 animate-pulse rounded-lg border border-border bg-surface shadow-1" />
    ),
    ssr: false,
  },
);

export function FinanceSettingsLoader({
  currentRole,
  settings,
}: {
  currentRole: string;
  settings: FinanceSettingsValues;
}) {
  return <FinanceSettingsPanel currentRole={currentRole} settings={settings} />;
}
