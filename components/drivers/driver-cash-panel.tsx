'use client';

import { DriverRemittanceForm } from '@/components/drivers/driver-remittance-form';
import { SettlementHistoryTable } from '@/components/drivers/settlement-history';
import {
  type DriverCashData,
  type SettlementHistoryRow,
  getDriverCashConsolidation,
  getDriverSettlementHistory,
} from '@/lib/actions/drivers';
import { formatMoney } from '@/lib/format/fcfa';
import { PERIOD_PRESETS, resolvePeriodRange } from '@/lib/periods/date-range';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

function statCard(label: string, value: string, accent?: boolean) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-1">
      <p className="text-[13px] font-medium text-muted">{label}</p>
      <p
        className={`mt-2 font-mono text-2xl font-semibold tabular-nums ${accent ? 'text-accent' : ''}`}
      >
        {value}
      </p>
    </section>
  );
}

type Props = {
  driverId: string;
  initialCash: DriverCashData;
  initialHistory: SettlementHistoryRow[];
};

// Panneau cash d'un livreur. Après une remise, on relit la conso FRAÎCHE côté
// serveur (getDriverCashConsolidation → deriveDriverCashConsolidation, la MÊME
// fonction/source que le RSC) et on stocke le résultat dans un état client. Le
// client n'arbitre JAMAIS l'écart lui-même (aucun recalcul parallèle → aucun
// drift, cf. piège matchesOrderSavedView). On NE dépend PAS de router.refresh()
// dont le re-render RSC à travers ce composant client était racey (~27% de ratés
// en build prod → chiffre cash périmé jusqu'au rechargement).
export function DriverCashPanel({ driverId, initialCash, initialHistory }: Props) {
  const t = useTranslations('livreurs.cash');
  const [cash, setCash] = useState(initialCash);
  const [history, setHistory] = useState(initialHistory);
  const [, startTransition] = useTransition();
  const searchParams = useSearchParams();

  // Après une remise : relit la conso cash ET l'historique des versements FRAIS
  // côté serveur (même source que le RSC) → aucun drift, pas de router.refresh().
  // La période relue doit matcher celle affichée à l'écran (collecté/frais sont
  // scopés à la période, cf. getDriverCashConsolidation) — même résolution que
  // le RSC, à partir des mêmes searchParams (period/from/to écrits par nuqs).
  const refreshCash = () => {
    const { from, to } = resolvePeriodRange({
      allowedPresets: PERIOD_PRESETS,
      defaultPreset: '30j',
      from: searchParams.get('from') ?? undefined,
      period: searchParams.get('period') ?? undefined,
      to: searchParams.get('to') ?? undefined,
    });
    const period = { from: from.toISOString(), to: to.toISOString() };

    startTransition(async () => {
      const [nextCash, nextHistory] = await Promise.all([
        getDriverCashConsolidation(driverId, period),
        getDriverSettlementHistory(driverId),
      ]);
      setCash(nextCash);
      if (nextHistory.ok) setHistory(nextHistory.rows);
    });
  };

  if (!cash.ok) {
    return <p className="text-sm text-danger">{cash.message}</p>;
  }

  const c = cash.consolidation;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {statCard(t('collectedTotal'), formatMoney(c.collectedMinor, 'XOF'))}
        {statCard(t('deliveryFees'), formatMoney(c.deliveryFeesMinor, 'XOF'))}
        {statCard(t('cashOnHand'), formatMoney(c.cashOnHandMinor, 'XOF'), true)}
      </div>
      {c.discrepancyMinor > 0 && (
        <p className="text-sm font-medium text-danger">
          {t('discrepancy', { amount: formatMoney(c.discrepancyMinor, 'XOF') })}
        </p>
      )}
      <div className="rounded-lg border border-border bg-surface p-4 shadow-1">
        <p className="mb-3 text-sm font-medium">{t('remittanceTitle')}</p>
        <DriverRemittanceForm driverId={driverId} onSettled={refreshCash} />
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">Historique des versements</p>
        <SettlementHistoryTable rows={history} />
      </div>
    </>
  );
}
