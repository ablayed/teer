'use client';

import { ProductAdSpendForm } from '@/components/purchases/product-ad-spend-form';
import { Amount } from '@/components/ui/amount';
import { DetailPanel } from '@/components/ui/detail-panel';
import { type ExplanationCardRow, computeExplanationTotal } from '@/components/ui/explanation-card';
import { GainLoss } from '@/components/ui/gain-loss';
import { ListCard } from '@/components/ui/list-card';
import { ScopedMetricCard } from '@/components/ui/scoped-metric-card';
import { type MoneyValueState, ValueAmount } from '@/components/ui/value-state';
import type { PurchaseLotData, PurchaseLotLineData } from '@/lib/actions/purchases';
import {
  getPurchaseLotProfitability,
  setPurchaseLotAllocationMethodAction,
  setPurchaseLotLineWeightAction,
} from '@/lib/actions/purchases';
import type { AllocationMethod } from '@/lib/finance/lot-profitability';
import type { PurchaseLotProfitabilitySummary } from '@/lib/finance/lot-profitability-assembly';
import { formatPercentFr } from '@/lib/format/percent';
import { type QueuedActionState, useQueuedAction } from '@/lib/offline/use-queued-action';
import { cn } from '@/lib/utils';
import { useAction } from 'next-safe-action/hooks';
import { useCallback, useEffect, useRef, useState } from 'react';

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

// Exporté pour que la vue arrivages de Finances (Lot F2-bis, elle ne fait que
// lister — jamais saisir) réutilise verbatim le même libellé qu'ici, plutôt
// que de dupliquer `MISSING_INPUT_LABELS` avec un risque de dérive de
// formulation entre les deux écrans.
export function missingInputLabel(key: string): string {
  return MISSING_INPUT_LABELS[key] ?? key;
}

// La marge % n'a de sens qu'une fois qu'il existe un CA encaissé au dénominateur —
// `cashCollectedMinor === 0` n'est pas « marge de 0 % » mais « rien à mesurer
// encore » (cf. lib/finance/lot-profitability.ts, computeMargin.marginPct).
// Distinct de MISSING_INPUT_LABELS : ce n'est pas un coût qui manque, c'est
// l'absence totale de la donnée amont (le CA) dont la marge % dérive.
// Exporté pour que `purchase-lots-view.tsx` (carte liste) affiche EXACTEMENT le
// même libellé que ce panneau détail pour le même état — cf. lexique
// (docs/lexique-microcopie.md).
export const MARGIN_PCT_MISSING_LABEL = 'Pas encore de CA encaissé sur cet arrivage';

function todayLabel(): string {
  return new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function periodLabel(lot: PurchaseLotData): string {
  const date = lot.receivedAt ?? lot.orderedAt;
  return `l'arrivage reçu le ${date}`;
}

/**
 * Rendu direct des lignes de calcul de la marge, SANS le bouton de divulgation
 * ni le second `DetailPanel` d'`ExplanationCard` (components/ui/explanation-card.tsx).
 * Imbriquer un `DetailPanel` (Drawer vaul sur mobile) dans un autre `DetailPanel`
 * n'utilise pas le mécanisme `Drawer.NestedRoot` de vaul — deux `Drawer.Root`
 * indépendants portent chacun leur propre verrou de scroll (`usePositionFixed`)
 * et leur propre calque modal Radix, qui `aria-hide` ses frères DOM (les deux
 * tiroirs sont portés dans <body>, donc frères, pas imbriqués dans le DOM réel)
 * — l'un des deux tiroirs se retrouve caché des lecteurs d'écran/hors du piège de
 * focus. On est déjà au niveau 2 de la divulgation ici (panneau détail de
 * l'arrivage) : la ligne de calcul de la marge s'affiche donc directement,
 * jamais derrière un 3ᵉ niveau de tiroir.
 */
function MarginBreakdown({
  rows,
  totalSentence,
}: {
  rows: ExplanationCardRow[];
  totalSentence: string;
}) {
  const total = computeExplanationTotal(rows);
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
      {rows.map((row) => (
        <div className="flex items-baseline justify-between gap-4" key={row.sentence}>
          <span className="text-sm text-text">{row.sentence}</span>
          <ValueAmount className="shrink-0" state={row.state} />
        </div>
      ))}
      <div className="border-t border-border pt-3">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-sm font-semibold text-text">{totalSentence}</span>
          <ValueAmount className="shrink-0 text-base font-semibold" state={total} />
        </div>
      </div>
    </div>
  );
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
  // État local (Paradigm B) : après une écriture réussie (méthode/poids), on relit
  // la rentabilité FRAÎCHE côté serveur (`getPurchaseLotProfitability`, même fonction
  // que le RSC) et on l'injecte ici — jamais de `router.refresh()`, dont le
  // re-render RSC à travers ce composant client est racey en build de prod (cf.
  // CLAUDE.md, driver-cash-panel.tsx pour le même motif). `currentLot` suit les
  // mêmes mises à jour optimistes (méthode/poids choisis) car `lot.lines[].weightGrams`
  // et `lot.allocationMethod` pilotent l'affichage de `AllocationSection`
  // indépendamment de `profitability`.
  const [currentLot, setCurrentLot] = useState(lot);
  const [currentProfitability, setCurrentProfitability] =
    useState<PurchaseLotProfitabilitySummary>(profitability);
  // Un seul formulaire de dépense publicitaire ouvert à la fois (« un enregistrement
  // à la fois ») — clé = purchaseLotLineId de la ligne dont le bouton a été cliqué.
  const [adSpendOpenFor, setAdSpendOpenFor] = useState<string | null>(null);

  const refreshProfitability = useCallback(async () => {
    const next = await getPurchaseLotProfitability(lot.id);
    setCurrentProfitability(next);
  }, [lot.id]);

  // Le transport (Lot F2-bis) se corrige depuis `LotCard`, un ANCÊTRE de ce
  // panneau — jamais depuis ici. `lot` (prop) change alors de valeur sans que
  // ce composant démonte/remonte : sans cet effet, `currentLot`/
  // `currentProfitability` resteraient figés sur l'ancien transport jusqu'à la
  // prochaine action interne (méthode/poids/pub). La ref évite de redéclencher
  // ce refetch au montage (où `currentLot`/`currentProfitability` viennent déjà
  // d'être initialisés depuis les mêmes props, une relecture serait redondante).
  const lastKnownTransportTotalRef = useRef(lot.transportTotal);
  useEffect(() => {
    if (lastKnownTransportTotalRef.current === lot.transportTotal) return;
    lastKnownTransportTotalRef.current = lot.transportTotal;
    setCurrentLot(lot);
    void refreshProfitability();
  }, [lot, refreshProfitability]);

  const handleMethodChanged = useCallback(
    (method: AllocationMethod) => {
      setCurrentLot((prev) => ({ ...prev, allocationMethod: method }));
      void refreshProfitability();
    },
    [refreshProfitability],
  );

  const handleWeightSaved = useCallback(
    (lineId: string, weightGrams: number | null) => {
      setCurrentLot((prev) => ({
        ...prev,
        lines: prev.lines.map((l) => (l.id === lineId ? { ...l, weightGrams } : l)),
      }));
      void refreshProfitability();
    },
    [refreshProfitability],
  );

  if (!currentProfitability.ok) {
    return (
      <DetailPanel
        closeLabel="Fermer"
        open={open}
        title={currentLot.supplierName}
        onClose={onClose}
      >
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted">
            {currentProfitability.reason === 'not_found'
              ? "Arrivage introuvable. La rentabilité n'a pas pu être calculée."
              : 'Rentabilité indisponible pour le moment. Réessayez plus tard.'}
          </p>
          {/* Le calcul de rentabilité peut échouer sans empêcher de configurer
              la répartition du transport — les deux gestes sont indépendants
              (la RPC de lecture peut être en panne pendant que les écritures
              restent disponibles). */}
          <AllocationSection
            lot={currentLot}
            currentMethod={currentLot.allocationMethod}
            onMethodChanged={handleMethodChanged}
            onWeightSaved={handleWeightSaved}
          />
        </div>
      </DetailPanel>
    );
  }

  if (!currentProfitability.allocationMethodAvailable) {
    return (
      <DetailPanel
        closeLabel="Fermer"
        open={open}
        title={currentLot.supplierName}
        onClose={onClose}
      >
        <div className="space-y-3 p-4">
          <p className="text-sm text-warning">
            Répartition au poids indisponible : au moins une ligne n'a pas de poids renseigné.
          </p>
          <AllocationSection
            lot={currentLot}
            currentMethod={currentProfitability.allocationMethod}
            onMethodChanged={handleMethodChanged}
            onWeightSaved={handleWeightSaved}
          />
        </div>
      </DetailPanel>
    );
  }

  const { totals, lines } = currentProfitability;
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

  const lineMetaById = new Map(currentLot.lines.map((l) => [l.id, l]));

  const marginPctMissing = totals.cashCollectedMinor === 0;

  return (
    <DetailPanel
      closeLabel="Fermer"
      open={open}
      title={`Rentabilité — ${currentLot.supplierName}`}
      onClose={onClose}
    >
      <div className="space-y-4 p-4">
        <GainLoss
          amountMinor={totals.marginMinor}
          labels={{ gain: 'Marge', loss: 'Marge', neutral: 'Marge nulle' }}
        />
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium text-muted">Marge</p>
            <p className="text-xs text-muted">Sur {periodLabel(currentLot)}</p>
          </div>
          <MarginBreakdown rows={marginRows} totalSentence="Marge de l'arrivage" />
        </div>
        {!totals.complete && (
          <p className="text-xs text-warning">
            Marge provisoire — en attente de :{' '}
            {totals.missingInputs.map(missingInputLabel).join(', ')}.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <ScopedMetricCard
            label="CA encaissé"
            scope={{ kind: 'flow', periodLabel: periodLabel(currentLot) }}
            value={<Amount amountMinor={totals.cashCollectedMinor} />}
          />
          <ScopedMetricCard
            label="Coût de revient des vendus"
            scope={{ kind: 'flow', periodLabel: periodLabel(currentLot) }}
            value={<ValueAmount className="text-2xl font-semibold" state={costOfSoldState} />}
          />
          <ScopedMetricCard
            label="Dépenses publicitaires"
            scope={{ kind: 'flow', periodLabel: periodLabel(currentLot) }}
            value={<ValueAmount className="text-2xl font-semibold" state={adSpendState} />}
          />
          <ScopedMetricCard
            label="Marge %"
            scope={{ kind: 'flow', periodLabel: periodLabel(currentLot) }}
            value={
              marginPctMissing ? (
                <ValueAmount
                  className="text-2xl font-semibold"
                  state={{ kind: 'missing', label: MARGIN_PCT_MISSING_LABEL }}
                />
              ) : (
                <span className={cn('text-2xl font-semibold', !totals.complete && 'text-warning')}>
                  {formatPercentFr(totals.marginPct)} %
                </span>
              )
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
          <AllocationSection
            lot={currentLot}
            currentMethod={currentProfitability.allocationMethod}
            onMethodChanged={handleMethodChanged}
            onWeightSaved={handleWeightSaved}
          />
          <div className="space-y-2">
            {lines.map((line) => {
              const meta = lineMetaById.get(line.purchaseLotLineId);
              const isAdSpendOpen = adSpendOpenFor === line.purchaseLotLineId;
              return (
                <div key={line.purchaseLotLineId} className="space-y-2">
                  <ListCard
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
                  {/* Rentabilité déjà ouverte au niveau 2 de divulgation : un
                      formulaire inline (jamais un 3ᵉ `DetailPanel` imbriqué, cf.
                      commentaire de `MarginBreakdown` ci-dessus sur les tiroirs
                      vaul frères non imbriqués dans le DOM). Un seul ouvert à la
                      fois, piloté par `adSpendOpenFor`. */}
                  {isAdSpendOpen ? (
                    <div className="rounded-lg border border-border bg-surface-1 p-3">
                      <ProductAdSpendForm
                        productId={line.productId}
                        productLabel={meta?.productTitle}
                        lockedPurchaseLotId={currentLot.id}
                        lockedPurchaseLotLabel={`${currentLot.supplierName} — reçu le ${
                          currentLot.receivedAt ?? currentLot.orderedAt
                        }`}
                        onDone={() => {
                          setAdSpendOpenFor(null);
                          void refreshProfitability();
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setAdSpendOpenFor(null)}
                        className="mt-2 min-h-12 text-xs font-medium text-muted underline hover:text-text"
                      >
                        Annuler
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setAdSpendOpenFor(line.purchaseLotLineId)}
                      className="inline-flex min-h-12 items-center rounded-md border border-border bg-surface px-3 text-xs font-medium text-text hover:bg-canvas"
                    >
                      + Ajouter une dépense publicitaire
                    </button>
                  )}
                </div>
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
  onMethodChanged,
  onWeightSaved,
}: {
  lot: PurchaseLotData;
  currentMethod: AllocationMethod;
  onMethodChanged: (method: AllocationMethod) => void;
  onWeightSaved: (lineId: string, weightGrams: number | null) => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
      <MethodSelector lot={lot} currentMethod={currentMethod} onMethodChanged={onMethodChanged} />
      <WeightEditor lot={lot} onWeightSaved={onWeightSaved} />
    </div>
  );
}

function MethodSelector({
  lot,
  currentMethod,
  onMethodChanged,
}: {
  lot: PurchaseLotData;
  currentMethod: AllocationMethod;
  onMethodChanged: (method: AllocationMethod) => void;
}) {
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
    // Paradigm B : le parent relit la rentabilité fraîche côté serveur et met à
    // jour son état local — jamais de `router.refresh()` (Router Cache racey en
    // build de prod, cf. CLAUDE.md). La méthode elle-même est connue ici sans
    // relecture (c'est la valeur qu'on vient d'écrire).
    onMethodChanged(method);
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
                'min-h-12 rounded-md border px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50',
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

function WeightEditor({
  lot,
  onWeightSaved,
}: {
  lot: PurchaseLotData;
  onWeightSaved: (lineId: string, weightGrams: number | null) => void;
}) {
  return (
    <div className="space-y-2 border-t border-border pt-2">
      <p className="text-xs font-medium text-muted">Poids par ligne (grammes)</p>
      <div className="space-y-2">
        {lot.lines.map((line) => (
          <WeightEditorRow key={line.id} lot={lot} line={line} onWeightSaved={onWeightSaved} />
        ))}
      </div>
    </div>
  );
}

const WEIGHT_BUTTON_LABEL: Record<QueuedActionState, string> = {
  idle: 'Enregistrer',
  saving: 'Enregistrement…',
  queued: "Enregistré sur l'appareil — en attente de synchronisation",
  synced: 'Enregistré',
  error: 'Réessayer',
};

// Nombre entier positif ou vide (poids non renseigné) — même règle de validation
// que handleSave, mais séparée pour piloter l'état visuel au blur sans
// déclencher d'enregistrement (cf. commentaire sur handleBlur ci-dessous).
// `undefined` = invalide, `null` = vide (poids effacé), `number` = valeur saisie.
function parseWeightInput(raw: string): number | null | undefined {
  if (raw.trim() === '') {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return !Number.isFinite(parsed) || parsed < 0 ? undefined : parsed;
}

function WeightEditorRow({
  lot,
  line,
  onWeightSaved,
}: {
  lot: PurchaseLotData;
  line: PurchaseLotLineData;
  onWeightSaved: (lineId: string, weightGrams: number | null) => void;
}) {
  const initialValue = line.weightGrams != null ? String(line.weightGrams) : '';
  const [value, setValue] = useState(initialValue);
  const [validationError, setValidationError] = useState<string | null>(null);
  // Poids associé à la dernière soumission — capturé au moment du `submit`,
  // relu par l'effet `synced` ci-dessous (la saisie peut avoir changé entre
  // temps, `pendingWeightRef` ne bouge pas avec elle).
  const pendingWeightRef = useRef<number | null>(line.weightGrams);
  const onWeightSavedRef = useRef(onWeightSaved);
  onWeightSavedRef.current = onWeightSaved;

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

  // Un `synced` réel (mutation réglée, jamais juste « tentative envoyée ») met à
  // jour l'état du parent (Paradigm B) — jamais `router.refresh()`, qui
  // n'entraîne pas de refetch client sans navigation et est racey en build de
  // prod (cf. CLAUDE.md, driver-cash-panel.tsx pour le même motif).
  useEffect(() => {
    if (weightAction.state === 'synced') {
      onWeightSavedRef.current(line.id, pendingWeightRef.current);
    }
  }, [weightAction.state, line.id]);

  // Validation à la sortie du champ, jamais soumission : le poids ne s'enregistre
  // que sur un clic explicite sur le bouton (exigence F2 — pas d'autosave sur
  // blur). Un blur ne fait donc RIEN d'autre qu'annoncer l'état de validation —
  // `handleBlur` n'appelle jamais `submit`/`handleSave`, donc il n'existe plus de
  // scénario de double-soumission bouton+blur à garder contre : `handleSave` n'est
  // invoqué que par le clic explicite sur le bouton, et `disabled={weightAction.state
  // === 'saving'}` sur ce bouton suffit à empêcher un double-clic accidentel pendant
  // une soumission en vol. Une garde par égalité de valeur avait précédemment été
  // ajoutée ici mais rendait « Réessayer » inopérant (elle comparait à la valeur
  // qu'on vient d'assigner avant l'échec) — retirée plutôt que réparée, faute de
  // scénario réel à couvrir.
  function handleBlur() {
    const parsed = parseWeightInput(value);
    setValidationError(
      parsed === undefined ? 'Poids invalide : entier positif ou champ vide attendu.' : null,
    );
  }

  async function handleSave() {
    const parsed = parseWeightInput(value);
    if (parsed === undefined) {
      setValidationError('Poids invalide : entier positif ou champ vide attendu.');
      return;
    }
    setValidationError(null);
    pendingWeightRef.current = parsed;
    // Clé d'idempotence DÉTERMINISTE par ligne (jamais un id aléatoire par clic) :
    // `listQueuedMutations()` lit IndexedDB par ORDRE DE CLÉ, pas d'insertion — sans
    // ceci, deux clics successifs sur « Enregistrer » pour la MÊME ligne (ex. 500
    // puis correction à 600) créeraient deux enregistrements distincts dont l'ordre
    // d'application au retour réseau n'est pas garanti suivre l'ordre de saisie,
    // risquant de faire gagner la valeur la plus ancienne. Avec cette clé stable,
    // le second submit écrase le premier enregistrement en file (même id) — seule
    // la DERNIÈRE valeur saisie par le marchand est jamais appliquée. Corollaire :
    // un clic sur « Réessayer » après échec réutilise aussi cet id, donc relance la
    // même mutation plutôt que d'en empiler une nouvelle en permanence.
    await weightAction.submit(
      { lotId: lot.id, lineId: line.id, weightGrams: parsed },
      `set_purchase_lot_line_weight:${line.id}`,
    );
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
          onBlur={handleBlur}
          className="min-h-12 w-28 min-w-0 rounded-md border border-border bg-surface px-2 py-1 text-sm tabular-nums"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={weightAction.state === 'saving'}
          className="min-h-12 shrink-0 rounded-md border border-border px-3 text-xs font-medium text-text hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
        >
          {WEIGHT_BUTTON_LABEL[weightAction.state]}
        </button>
      </div>
      {validationError && (
        <p className="text-xs text-danger" role="alert">
          {validationError}
        </p>
      )}
      {weightAction.state === 'error' && weightAction.errorMessage && (
        <p className="text-xs text-danger" role="alert">
          {weightAction.errorMessage}
        </p>
      )}
    </div>
  );
}
