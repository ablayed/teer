'use client';

import { DriverRemittanceForm } from '@/components/drivers/driver-remittance-form';
import { SettlementHistoryTable } from '@/components/drivers/settlement-history';
import { usePeriodParams } from '@/components/period-picker/use-period-params';
import { DefinitionToggle } from '@/components/ui/definition-card';
import {
  type DriverCashData,
  type SettlementHistoryRow,
  getDriverCashConsolidation,
  getDriverSettlementHistory,
} from '@/lib/actions/drivers';
import { derivePeriodCashOnHand } from '@/lib/drivers/cash-consolidation';
import { formatMoney } from '@/lib/format/fcfa';
import { PERIOD_PRESETS, resolvePeriodRange } from '@/lib/periods/date-range';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

// Même défaut que resolvePeriodRange dans app/(app)/livreurs/page.tsx:92 — le
// bouton reset ramène le PeriodPicker déjà monté (drivers-workspace.tsx) à ce
// preset, purement client (usePeriodParams().selectPreset), aucune écriture serveur.
const DEFAULT_PERIOD_PRESET = '30j';

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

// Label <p> et value <p> restent des ENFANTS DIRECTS de <section>, siblings
// immédiats — exactement la même forme que statCard(). L'E2E existant
// (statValue(), drivers.spec.ts) résout la valeur via
// `getByText(label).locator('xpath=following-sibling::p[1]')` : nester le
// label dans un <div> (pour loger un bouton "action" à côté) casserait ce
// sibling direct. Le bouton reset va donc dans la rangée du bas, à côté du
// DefinitionToggle, jamais à côté du label.
function cashCardWithDefinition({
  accent,
  action,
  definition,
  label,
  value,
}: {
  accent?: boolean;
  action?: React.ReactNode;
  definition: string;
  label: string;
  value: string;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-1">
      <p className="text-[13px] font-medium text-muted">{label}</p>
      <p
        className={`mt-2 font-mono text-2xl font-semibold tabular-nums ${accent ? 'text-accent' : ''}`}
      >
        {value}
      </p>
      {/* `flex-wrap` : une action au libellé long (« Enregistrer un versement »)
          déborde sinon de la carte et se retrouve SOUS la carte voisine de la
          grille, qui intercepte alors le clic. On n'ajoute que le retour à la
          ligne — le modèle de boîte (flex) reste identique, donc les cartes dont
          l'action tient déjà sur la ligne sont inchangées. */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <DefinitionToggle definition={definition} />
        {action}
      </div>
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
  // Partie 2 : demande de préremplissage envoyée au formulaire de versement déjà
  // monté plus bas. Le compteur `nonce` (et non la valeur) déclenche l'application
  // côté formulaire — cf. DriverRemittanceForm.
  const [prefill, setPrefill] = useState<{ amountMinor: number; nonce: number } | null>(null);
  const [, startTransition] = useTransition();
  const searchParams = useSearchParams();
  const { selectPreset } = usePeriodParams();

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
  const periodCashOnHandMinor = derivePeriodCashOnHand({
    periodCollectedMinor: c.collectedMinor,
    periodCollectedDeliveryFeesMinor: c.collectedDeliveryFeesMinor,
    periodRemittedMinor: cash.periodRemittedMinor,
  });

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {statCard(t('collectedTotal'), formatMoney(c.collectedMinor, 'XOF'))}
        {statCard(t('deliveryFees'), formatMoney(c.collectedDeliveryFeesMinor, 'XOF'))}
        {cashCardWithDefinition({
          accent: true,
          // Partie 2 — raccourci de règlement. Ce bouton n'enregistre RIEN : il
          // propose au formulaire déjà monté ci-dessous le solde live affiché sur
          // cette carte, puis y amène le marchand. Le mécanisme de versement
          // (recordSettlementAction → record_cash_settlement) reste inchangé et
          // reste le seul chemin d'écriture, avec son RBAC owner/manager existant.
          action: (
            <button
              className="min-h-9 rounded-full border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-canvas hover:text-text"
              data-testid="driver-cash-settle-shortcut"
              onClick={() =>
                setPrefill((previous) => ({
                  amountMinor: c.cashOnHandMinor,
                  nonce: (previous?.nonce ?? 0) + 1,
                }))
              }
              type="button"
            >
              {t('settleNow')}
            </button>
          ),
          definition: t('cashOnHandLiveDefinition'),
          label: t('cashOnHand'),
          value: formatMoney(c.cashOnHandMinor, 'XOF'),
        })}
        {cashCardWithDefinition({
          accent: true,
          action: (
            <button
              className="shrink-0 rounded-full border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-canvas hover:text-text"
              onClick={() => selectPreset(DEFAULT_PERIOD_PRESET)}
              type="button"
            >
              {t('resetPeriod')}
            </button>
          ),
          definition: t('cashOnHandPeriodDefinition'),
          label: t('cashOnHandPeriod'),
          value: formatMoney(periodCashOnHandMinor, 'XOF'),
        })}
      </div>
      {c.discrepancyMinor > 0 && (
        <p className="text-sm font-medium text-danger">
          {t('discrepancy', { amount: formatMoney(c.discrepancyMinor, 'XOF') })}
        </p>
      )}
      <div className="rounded-lg border border-border bg-surface p-4 shadow-1">
        <p className="mb-3 text-sm font-medium">{t('remittanceTitle')}</p>
        <DriverRemittanceForm driverId={driverId} onSettled={refreshCash} prefill={prefill} />
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">Historique des versements</p>
        <SettlementHistoryTable rows={history} />
      </div>
    </>
  );
}
