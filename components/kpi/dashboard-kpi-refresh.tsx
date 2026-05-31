'use client';

import { KPICard } from '@/components/kpi/KPICard';
import { type DashboardKpi, getDashboardKpiAction } from '@/lib/actions/dashboard';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import React, { useEffect, useMemo, useState } from 'react';

type DashboardKpiRefreshProps = {
  initialKpi: DashboardKpi | null;
  initialUpdatedAt: string;
};

const timeFormatter = new Intl.DateTimeFormat('fr-FR', {
  hour: '2-digit',
  hour12: false,
  minute: '2-digit',
});

function formatRefreshTime(value: string): string {
  return timeFormatter.format(new Date(value));
}

export function DashboardKpiRefresh({ initialKpi, initialUpdatedAt }: DashboardKpiRefreshProps) {
  const t = useTranslations('tableau');
  const kpiAction = useAction(getDashboardKpiAction);
  const [kpi, setKpi] = useState<DashboardKpi | null>(initialKpi);
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt);
  const isLoading = kpiAction.isExecuting && !kpi;
  const hasError = kpiAction.result.data?.ok === false;

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      kpiAction.execute();
    }, 60_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [kpiAction]);

  useEffect(() => {
    const result = kpiAction.result.data;

    if (result?.ok) {
      setKpi(result.data);
      setUpdatedAt(new Date().toISOString());
    }
  }, [kpiAction.result.data]);

  const sparkline = useMemo(
    () => kpi?.sparkline7j.map((point) => ({ date: point.date, value: point.caCollecte })) ?? [],
    [kpi],
  );

  return (
    <section className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className="sm:col-span-2 xl:col-span-1">
          <KPICard
            deltaAbs={kpi?.aAppelerDelta}
            deltaType="abs"
            error={hasError}
            invertDelta
            label={t('kpi.a_appeler')}
            loading={isLoading}
            unit="count"
            value={kpi?.aAppelerCount ?? 0}
          />
        </div>
        <KPICard
          accentColor="success"
          error={hasError}
          label={t('kpi.ca_collecte')}
          loading={isLoading}
          sparkline={sparkline}
          unit="XOF"
          value={kpi?.caCollecte7j ?? 0}
        />
        <KPICard
          accentColor="warning"
          error={hasError}
          label={t('kpi.ca_attente')}
          loading={isLoading}
          unit="XOF"
          value={kpi?.caEnAttente ?? 0}
        />
        <KPICard
          error={hasError}
          label={t('kpi.taux_confirmation')}
          loading={isLoading}
          unit="%"
          value={kpi?.tauxConfirmation ?? 0}
        />
        <KPICard
          error={hasError}
          label={t('kpi.taux_livraison')}
          loading={isLoading}
          unit="%"
          value={kpi?.tauxLivraison ?? 0}
        />
      </div>

      <p className="text-right text-xs text-muted">
        {t('refresh.label', { time: formatRefreshTime(updatedAt) })}
      </p>
    </section>
  );
}
