'use client';

import { Amount } from '@/components/ui/amount';
import { DetailPanel } from '@/components/ui/detail-panel';
import { ExplanationCard, type ExplanationCardRow } from '@/components/ui/explanation-card';
import { GainLoss } from '@/components/ui/gain-loss';
import { ListCard } from '@/components/ui/list-card';
import { ScopedMetricCard } from '@/components/ui/scoped-metric-card';
import { type MoneyValueState, ValueAmount } from '@/components/ui/value-state';
import type { PurchaseLotData, PurchaseLotLineData } from '@/lib/actions/purchases';
import {
  setPurchaseLotAllocationMethodAction,
  setPurchaseLotLineWeightAction,
} from '@/lib/actions/purchases';
import type { AllocationMethod } from '@/lib/finance/lot-profitability';
import type { PurchaseLotProfitabilitySummary } from '@/lib/finance/lot-profitability-assembly';
import { type QueuedActionState, useQueuedAction } from '@/lib/offline/use-queued-action';
import { cn } from '@/lib/utils';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const METHOD_LABELS: Record<AllocationMethod, string> = {
  value: 'À la valeur',
  quantity: 'À la quantité',
  weight: 'Au poids',
};

// Libellés des entrées qui peuvent rendre la marge provisoire — cf.
// lib/finance/lot-profitability.ts (computeMargin.missingInputs). `ad_spend`
// n'est actuellement jamais produit par l'assemblage F2 (complete: true figé
// dans computeAdSpendByLine) mais on ne code pas en dur « transport » seul :
// si l'assemblage évolue, ce libellé suit sans changement ici.
const MISSING_INPUT_LABELS: Record<string, string> = {
  transport_total: 'Transport pas encore facturé',
  ad_spend: 'Publicité pas encore saisie',
};

function missingInputLabel(key: string): string {
  return MISSING_INPUT_LABELS[key] ?? key;
}

function todayLabel(): string {
  return new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function periodLabel(lot: PurchaseLotData): string {
  const date = lot.receivedAt ?? lot.orderedAt;
  return `l'arrivage reçu le ${date}`;
}

export function PurchaseLotDetailPanel({
  lot,
  profitability,
  open,
  onClose,
}: {
  lot: PurchaseLotData;
  profitability: PurchaseLotProfitabilitySummary;
  open: boolean;
  onClose: () => void;
}) {
  if (!profitability.ok) {
    return (
      <DetailPanel closeLabel="Fermer" open={open} title={lot.supplierName} onClose={onClose}>
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted">
            {profitability.reason === 'not_found'
              ? "Arrivage introuvable. La rentabilité n'a pas pu être calculée."
              : 'Rentabilité indisponible pour le moment. Réessayez plus tard.'}
          </p>
          {/* Le calcul de rentabilité peut échouer sans empêcher de configurer
              la répartition du transport — les deux gestes sont indépendants
              (la RPC de lecture peut être en panne pendant que les écritures
              restent disponibles). */}
          <AllocationSection lot={lot} currentMethod={lot.allocationMethod} />
        </div>
      </DetailPanel>
    );
  }

  if (!profitability.allocationMethodAvailable) {
    return (
      <DetailPanel closeLabel="Fermer" open={open} title={lot.supplierName} onClose={onClose}>
        <div className="space-y-3 p-4">
          <p className="text-sm text-warning">
            Répartition au poids indisponible : au moins une ligne n'a pas de poids renseigné.
          </p>
          <AllocationSection lot={lot} currentMethod={profitability.allocationMethod} />
        </div>
      </DetailPanel>
    );
  }

  const { totals, lines } = profitability;
  const transportEstimated = totals.missingInputs.includes('transport_total');
  const adSpendEstimated = totals.missingInputs.includes('ad_spend');

  const costOfSoldState: MoneyValueState = transportEstimated
    ? {
        kind: 'estimated',
        amountMinor: totals.costOfSoldMinor,
        label: missingInputLabel('transport_total'),
      }
    : { kind: 'confirmed', amountMinor: totals.costOfSoldMinor };

  const adSpendState: MoneyValueState = adSpendEstimated
    ? {
        kind: 'estimated',
        amountMinor: totals.adSpendMinor,
        label: missingInputLabel('ad_spend'),
      }
    : { kind: 'confirmed', amountMinor: totals.adSpendMinor };

  const marginRows: ExplanationCardRow[] = [
    {
      sentence: 'Vous avez encaissé',
      sign: 'add',
      state: { kind: 'confirmed', amountMinor: totals.cashCollectedMinor },
    },
    { sentence: 'Les articles vendus vous ont coûté', sign: 'subtract', state: costOfSoldState },
    { sentence: 'La publicité vous a coûté', sign: 'subtract', state: adSpendState },
  ];

  const lineMetaById = new Map(lot.lines.map((l) => [l.id, l]));

  return (
    <DetailPanel
      closeLabel="Fermer"
      open={open}
      title={`Rentabilité — ${lot.supplierName}`}
      onClose={onClose}
    >
      <div className="space-y-4 p-4">
        <GainLoss
          amountMinor={totals.marginMinor}
          labels={{ gain: 'Marge', loss: 'Marge', neutral: 'Marge nulle' }}
        />
        <ExplanationCard
          label="Marge"
          rows={marginRows}
          scope={{ kind: 'flow', periodLabel: periodLabel(lot) }}
          totalSentence="Marge de l'arrivage"
        />
        {!totals.complete && (
          <p className="text-xs text-warning">
            Marge provisoire — en attente de :{' '}
            {totals.missingInputs.map(missingInputLabel).join(', ')}.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <ScopedMetricCard
            label="CA encaissé"
            scope={{ kind: 'flow', periodLabel: periodLabel(lot) }}
            value={<Amount amountMinor={totals.cashCollectedMinor} />}
          />
          <ScopedMetricCard
            label="Coût de revient des vendus"
            scope={{ kind: 'flow', periodLabel: periodLabel(lot) }}
            value={<ValueAmount className="text-2xl font-semibold" state={costOfSoldState} />}
          />
          <ScopedMetricCard
            label="Dépenses publicitaires"
            scope={{ kind: 'flow', periodLabel: periodLabel(lot) }}
            value={<ValueAmount className="text-2xl font-semibold" state={adSpendState} />}
          />
          <ScopedMetricCard
            label="Marge %"
            scope={{ kind: 'flow', periodLabel: periodLabel(lot) }}
            value={
              <span className={cn('text-2xl font-semibold', !totals.complete && 'text-warning')}>
                {(totals.marginPct * 100).toFixed(1)} %
              </span>
            }
          />
        </div>

        <ScopedMetricCard
          label="Invendu"
          scope={{ kind: 'balance', asOfLabel: todayLabel() }}
          value={
            <span className="inline-flex items-baseline gap-2">
              <span>{totals.unsoldUnits} unités</span>
              <span className="text-base font-normal text-muted">—</span>
              <Amount amountMinor={totals.unsoldCostEngagedMinor} />
            </span>
          }
          delta="Coût de revient déjà engagé sur les unités non vendues"
        />

        <ScopedMetricCard
          label="Avancement des ventes"
          scope={{ kind: 'balance', asOfLabel: todayLabel() }}
          value={
            <span>
              {totals.qtySold} vendues / {totals.qtyReceived - totals.qtySold} restantes
            </span>
          }
        />

        <section className="space-y-2">
          <p className="text-sm font-medium text-text">Répartition par produit</p>
          <AllocationSection lot={lot} currentMethod={profitability.allocationMethod} />
          <div className="space-y-2">
            {lines.map((line) => {
              const meta = lineMetaById.get(line.purchaseLotLineId);
              return (
                <ListCard
                  key={line.purchaseLotLineId}
                  title={meta?.productTitle ?? line.productId}
                  primaryValue={<Amount amountMinor={line.allocatedTransportMinor} />}
                  secondary={[
                    {
                      label: 'Coût de revient rendu',
                      value: (
                        <ValueAmount
                          state={
                            transportEstimated
                              ? {
                                  kind: 'estimated',
                                  amountMinor: line.landedUnitCostMinor,
                                  label: missingInputLabel('transport_total'),
                                }
                              : { kind: 'confirmed', amountMinor: line.landedUnitCostMinor }
                          }
                        />
                      ),
                    },
                    {
                      label: 'Coût publicitaire / vente',
                      // `null` ici n'est PAS « pas encore saisi » (ce serait le
                      // guard `ValueAmount`/`missing` ci-dessus) : c'est un
                      // ratio non défini (0 vente sur cette ligne, 0/0) — rien
                      // à nommer comme manquant, juste rien à diviser. D'où un
                      // tiret simple plutôt que le composant de garde.
                      value:
                        line.adSpendPerUnitMinor == null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <Amount amountMinor={line.adSpendPerUnitMinor} />
                        ),
                    },
                  ]}
                />
              );
            })}
          </div>
        </section>
      </div>
    </DetailPanel>
  );
}

// ── Répartition du transport (méthode + poids par ligne) ────────────────────

function AllocationSection({
  lot,
  currentMethod,
}: {
  lot: PurchaseLotData;
  currentMethod: AllocationMethod;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
      <MethodSelector lot={lot} currentMethod={currentMethod} />
      <WeightEditor lot={lot} />
    </div>
  );
}

function MethodSelector({
  lot,
  currentMethod,
}: {
  lot: PurchaseLotData;
  currentMethod: AllocationMethod;
}) {
  const router = useRouter();
  const setMethod = useAction(setPurchaseLotAllocationMethodAction);
  const [feedback, setFeedback] = useState<string | null>(null);

  // La méthode « au poids » n'est jamais proposée aveuglément : si une seule
  // ligne n'a pas de poids renseigné, on l'affiche mais désactivée, avec
  // l'explication du pourquoi — jamais silencieusement absente de la liste
  // (le marchand doit comprendre qu'elle existe mais n'est pas utilisable en l'état).
  const missingWeightLineTitles = lot.lines
    .filter((l) => l.weightGrams == null)
    .map((l) => l.productTitle);
  const weightAvailable = missingWeightLineTitles.length === 0;

  async function handleSelect(method: AllocationMethod) {
    setFeedback(null);
    const res = await setMethod.executeAsync({ lotId: lot.id, method });
    if (!res?.data?.ok) {
      setFeedback(res?.data?.message ?? 'Erreur.');
      return;
    }
    // `revalidatePath` (côté serveur, dans l'action) invalide le cache RSC mais
    // ne force pas ce client à le refetch tant qu'aucune navigation ne se
    // produit — sans ce refresh, le bouton sélectionné resterait visuellement
    // sur l'ancienne méthode malgré une écriture réussie (constaté en vérification manuelle).
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted">Méthode de répartition du transport</p>
      <div className="flex flex-wrap gap-2" aria-label="Méthode de répartition">
        {(Object.keys(METHOD_LABELS) as AllocationMethod[]).map((method) => {
          const disabled = method === 'weight' && !weightAvailable;
          const selected = currentMethod === method;
          return (
            <button
              key={method}
              type="button"
              aria-pressed={selected}
              disabled={disabled || setMethod.isExecuting}
              onClick={() => handleSelect(method)}
              className={cn(
                'min-h-11 rounded-md border px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50',
                selected
                  ? 'border-accent bg-accent-subtle text-text'
                  : 'border-border text-text hover:bg-canvas',
              )}
            >
              {METHOD_LABELS[method]}
            </button>
          );
        })}
      </div>
      {!weightAvailable && (
        <p className="text-xs text-warning">
          Répartition au poids indisponible : renseignez le poids de{' '}
          {missingWeightLineTitles.length === 1 ? 'cette ligne' : 'ces lignes'} (
          {missingWeightLineTitles.join(', ')}) pour l'activer.
        </p>
      )}
      {feedback && (
        <p className="text-xs text-danger" role="alert">
          {feedback}
        </p>
      )}
    </div>
  );
}

function WeightEditor({ lot }: { lot: PurchaseLotData }) {
  return (
    <div className="space-y-2 border-t border-border pt-2">
      <p className="text-xs font-medium text-muted">Poids par ligne (grammes)</p>
      <div className="space-y-2">
        {lot.lines.map((line) => (
          <WeightEditorRow key={line.id} lot={lot} line={line} />
        ))}
      </div>
    </div>
  );
}

const WEIGHT_BUTTON_LABEL: Record<QueuedActionState, string> = {
  idle: 'Enregistrer',
  saving: 'Enregistrement…',
  queued: 'En attente de connexion',
  synced: 'Enregistré',
  error: 'Réessayer',
};

function WeightEditorRow({ lot, line }: { lot: PurchaseLotData; line: PurchaseLotLineData }) {
  const router = useRouter();
  const [value, setValue] = useState(line.weightGrams != null ? String(line.weightGrams) : '');
  const weightAction = useQueuedAction(
    'set_purchase_lot_line_weight',
    async (input: { lotId: string; lineId: string; weightGrams: number | null }) => {
      const res = await setPurchaseLotLineWeightAction(input);
      return {
        ok: Boolean(res?.data?.ok),
        message: res?.data?.ok ? undefined : res?.data?.message,
      };
    },
  );

  // Un `synced` réel (mutation réglée, jamais juste « tentative envoyée ») doit
  // rafraîchir les données serveur affichées ailleurs dans le panneau (ex. la
  // disponibilité de la méthode « au poids ») — `revalidatePath` côté serveur
  // n'entraîne pas seul un refetch client sans navigation.
  useEffect(() => {
    if (weightAction.state === 'synced') {
      router.refresh();
    }
  }, [weightAction.state, router]);

  async function handleSave() {
    const parsed = value.trim() === '' ? null : Number.parseInt(value, 10);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      return;
    }
    await weightAction.submit({ lotId: lot.id, lineId: line.id, weightGrams: parsed });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <label className="min-w-0 flex-1 truncate text-sm text-text" htmlFor={`weight-${line.id}`}>
          {line.productTitle}
        </label>
        <input
          id={`weight-${line.id}`}
          type="number"
          min={0}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={handleSave}
          className="min-h-11 w-28 min-w-0 rounded-md border border-border bg-surface px-2 py-1 text-sm tabular-nums"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={weightAction.state === 'saving'}
          className="min-h-11 shrink-0 rounded-md border border-border px-3 text-xs font-medium text-text hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
        >
          {WEIGHT_BUTTON_LABEL[weightAction.state]}
        </button>
      </div>
      {weightAction.state === 'error' && weightAction.errorMessage && (
        <p className="text-xs text-danger" role="alert">
          {weightAction.errorMessage}
        </p>
      )}
    </div>
  );
}
