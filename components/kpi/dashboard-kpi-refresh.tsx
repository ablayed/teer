'use client';

import { KPICard } from '@/components/kpi/KPICard';
import { type DashboardKpi, getDashboardKpiAction } from '@/lib/actions/dashboard';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import Link from 'next/link';
import React, { useEffect, useState } from 'react';

type DashboardKpiRefreshProps = {
  // Population commandes « à appeler » derrière ce compteur : voir plan UX-COD-01 §1, un
  // compteur qui désigne une population traitable doit ouvrir cette population.
  aAppelerHref: string;
  initialError: boolean;
  initialKpi: DashboardKpi | null;
  initialUpdatedAt: string;
  shopId?: string | null;
};

const timeFormatter = new Intl.DateTimeFormat('fr-FR', {
  hour: '2-digit',
  hour12: false,
  minute: '2-digit',
});

function formatRefreshTime(value: string): string {
  return timeFormatter.format(new Date(value));
}

export function DashboardKpiRefresh({
  aAppelerHref,
  initialError,
  initialKpi,
  initialUpdatedAt,
  shopId = null,
}: DashboardKpiRefreshProps) {
  const t = useTranslations('tableau');
  const kpiAction = useAction(getDashboardKpiAction);
  const [kpi, setKpi] = useState<DashboardKpi | null>(initialKpi);
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt);
  const isLoading = kpiAction.isExecuting && !kpi;
  // Le chargement initial (serveur) peut échouer sans qu'aucun refresh client n'ait encore
  // eu lieu — kpiAction.result.data reste alors undefined. Ne jamais retomber sur `false`
  // (= "pas d'erreur") dans ce cas : ce serait exactement le repli silencieux que ce lot ferme.
  const hasError = kpiAction.result.data ? kpiAction.result.data.ok === false : initialError;

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      kpiAction.execute({ shopId });
    }, 60_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [kpiAction, shopId]);

  useEffect(() => {
    const result = kpiAction.result.data;

    if (result?.ok) {
      setKpi(result.data);
      setUpdatedAt(new Date().toISOString());
    }
  }, [kpiAction.result.data]);

  const unavailableLabel = t('kpi.unavailable');

  return (
    <section className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Link
          aria-label={t('kpi.a_appeler')}
          className="col-span-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent xl:col-span-1"
          href={aAppelerHref}
        >
          <KPICard
            deltaAbs={kpi?.a_appeler_delta}
            deltaType="abs"
            error={hasError}
            errorLabel={unavailableLabel}
            invertDelta
            label={t('kpi.a_appeler')}
            loading={isLoading}
            tone="attention"
            unit="count"
            value={kpi?.a_appeler_count ?? 0}
          />
        </Link>
        <KPICard
          currency={kpi?.currency}
          definition={t('kpi.ca_attente_def')}
          definitionFormula={t('kpi.ca_attente_formula')}
          error={hasError}
          errorLabel={unavailableLabel}
          label={t('kpi.ca_attente')}
          loading={isLoading}
          tone="warning"
          unit="currency"
          value={kpi?.ca_en_attente ?? 0}
        />
        <KPICard
          error={hasError}
          errorLabel={unavailableLabel}
          label={t('kpi.taux_confirmation')}
          loading={isLoading}
          unit="%"
          value={kpi?.taux_confirmation ?? 0}
        />
        <KPICard
          error={hasError}
          errorLabel={unavailableLabel}
          label={t('kpi.taux_livraison')}
          loading={isLoading}
          unit="%"
          value={kpi?.taux_livraison ?? 0}
        />
      </div>

      <p className="text-right text-xs text-muted">
        {t('refresh.label', { time: formatRefreshTime(updatedAt) })}
      </p>
    </section>
  );
}
