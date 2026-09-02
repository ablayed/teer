'use client';

import { StockShortageWarning } from '@/components/orders/stock-shortage-warning';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getDriverAvailableStockForAssignmentAction } from '@/lib/actions/assignment-stock';
import { getOrderRequiredStockAction } from '@/lib/actions/orders';
import {
  type CancelReason,
  cancelReasonLabels,
  cancelReasonValues,
} from '@/lib/domain/order-transition-actions';
import {
  dateTimeInputsToIso,
  isoToDateTimeInputs,
  nextWholeHourInputs,
  normalizeHourInput,
} from '@/lib/format/datetime-input';
import { type StockShortageRow, computeStockShortages } from '@/lib/orders/assignment-stock-check';
import { useAction } from 'next-safe-action/hooks';
import { useEffect, useId, useState } from 'react';

export type DriverOption = { id: string; fullName: string };

// Actions qui nécessitent une saisie avant que la transition ne s'exécute.
// 0114 : `livrer` en fait désormais partie — elle s'exécutait jusqu'ici directement
// au clic, sans aucune saisie.
export type PayloadDialogAction = 'assigner' | 'programmer' | 'annuler' | 'reprogrammer' | 'livrer';

export type TransitionPayload = {
  assignedDriverId?: string;
  deliveredAt?: string;
  scheduledFor?: string;
  cancelReasons?: CancelReason[];
  note?: string;
};

type TransitionDialogProps = {
  action: PayloadDialogAction;
  drivers: DriverOption[];
  // Lot 2 / PR 4 — active le check "Stock insuffisant" (chemin agent uniquement :
  // owner/manager revoit déjà l'alerte dans AssignmentDetailsDialog juste après ce
  // dialog, cf. OrderActionsMenu.handleDialogConfirm). Toujours false pour
  // programmer/annuler (le check ne concerne que action==='assigner').
  enableStockWarning?: boolean;
  isSubmitting: boolean;
  onCancel: () => void;
  onConfirm: (payload: TransitionPayload) => void;
  // Requis uniquement quand enableStockWarning est vrai.
  orderId?: string;
  // Fix 2 — date de livraison prévue de la commande (order.scheduled_for), utilisée
  // pour préremplir le dialog `livrer`. `null`/absente pour une commande jamais passée
  // par `programmer` : le champ reste vide, comportement inchangé.
  scheduledFor?: string | null;
};

const dialogTitles: Record<PayloadDialogAction, string> = {
  assigner: 'Assigner à un livreur',
  programmer: 'Programmer la livraison',
  annuler: 'Annuler la commande',
  reprogrammer: 'Reprogrammer la livraison',
  livrer: 'Marquer la commande livrée',
};

// 0114 — une date corrigée est OPTIONNELLE : laissée vide, la RPC garde son
// comportement d'avant ce lot (now(), ou scheduled_for pour la livraison). On ne
// renvoie donc une valeur que si les DEUX champs sont remplis ; un seul des deux
// est une saisie incomplète, jamais une date implicite.
function optionalDateTimeIso(date: string, time: string): string | null {
  if (!date || !time) {
    return null;
  }
  return dateTimeInputsToIso(date, time);
}

function isPartiallyFilled(date: string, time: string): boolean {
  return Boolean(date) !== Boolean(time);
}

export function TransitionDialog({
  action,
  drivers,
  enableStockWarning = false,
  isSubmitting,
  onCancel,
  onConfirm,
  orderId,
  scheduledFor: orderScheduledFor = null,
}: TransitionDialogProps) {
  const fieldId = useId();
  const defaultSchedule = nextWholeHourInputs();
  // Fix 2 — préremplie avec order.scheduled_for quand elle existe : l'agent voit et
  // corrige consciemment la date qui sera réellement utilisée (coalesce SQL 0114),
  // au lieu d'un champ vide masquant ce comportement. Vide si scheduled_for est null
  // (commande livrée sans être passée par `programmer`) : comportement inchangé.
  // Nommage local `orderScheduledFor` pour ne pas entrer en collision avec la
  // variable `scheduledFor` calculée plus bas dans handleConfirm (date programmée à
  // ENVOYER, distincte de la date programmée déjà EN BASE reçue ici en prop).
  const defaultDelivered = isoToDateTimeInputs(orderScheduledFor);
  const [driverId, setDriverId] = useState('');
  const [date, setDate] = useState(defaultSchedule.date);
  const [time, setTime] = useState(defaultSchedule.time);
  const [reasons, setReasons] = useState<Set<CancelReason>>(new Set());
  const [note, setNote] = useState('');
  const [deliveredDate, setDeliveredDate] = useState(defaultDelivered.date);
  const [deliveredTime, setDeliveredTime] = useState(defaultDelivered.time);
  const [stockShortages, setStockShortages] = useState<StockShortageRow[]>([]);
  const [stockCheckFailed, setStockCheckFailed] = useState(false);
  const fetchRequiredStock = useAction(getOrderRequiredStockAction);
  const fetchAvailableStock = useAction(getDriverAvailableStockForAssignmentAction);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onCancel();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const isAssign = action === 'assigner';
  const isCancel = action === 'annuler';
  const isDeliver = action === 'livrer';
  const title = dialogTitles[action];
  const hasNoDrivers = isAssign && drivers.length === 0;

  // Lot 2 / PR 4 — "Stock insuffisant" côté agent (TransitionDialog n'a qu'une seule étape :
  // dès que le livreur est choisi ici, "Valider" assigne directement pour un agent, cf.
  // OrderActionsMenu.handleDialogConfirm). Se réinitialise si driverId change (résultat
  // périmé de l'ancien livreur) ou si le check est désactivé. `cancelled` protège contre
  // une réponse tardive d'une sélection déjà remplacée par une autre.
  useEffect(() => {
    if (!enableStockWarning || !isAssign || !orderId || !driverId) {
      setStockShortages([]);
      setStockCheckFailed(false);
      return;
    }

    let cancelled = false;
    (async () => {
      const [requiredResult, availableResult] = await Promise.all([
        fetchRequiredStock.executeAsync({ orderId }),
        fetchAvailableStock.executeAsync({ driverId }),
      ]);
      if (cancelled) {
        return;
      }
      if (!requiredResult?.data?.ok || !availableResult?.data?.ok) {
        setStockCheckFailed(true);
        setStockShortages([]);
        return;
      }
      setStockShortages(computeStockShortages(requiredResult.data.rows, availableResult.data.rows));
      setStockCheckFailed(false);
    })();
    return () => {
      cancelled = true;
    };
    // orderId stable pour la durée de vie du dialog ; executeAsync mémoïsé.
  }, [
    enableStockWarning,
    isAssign,
    orderId,
    driverId,
    fetchRequiredStock.executeAsync,
    fetchAvailableStock.executeAsync,
  ]);

  function toggleReason(reason: CancelReason) {
    setReasons((current) => {
      const next = new Set(current);
      if (next.has(reason)) {
        next.delete(reason);
      } else {
        next.add(reason);
      }
      return next;
    });
  }

  const deliveredIncomplete = isDeliver && isPartiallyFilled(deliveredDate, deliveredTime);

  const canConfirm = isAssign
    ? Boolean(driverId)
    : isCancel
      ? reasons.size > 0
      : isDeliver
        ? !deliveredIncomplete
        : Boolean(dateTimeInputsToIso(date, time));

  function handleConfirm() {
    if (isAssign) {
      if (!driverId) {
        return;
      }
      onConfirm({ assignedDriverId: driverId });
      return;
    }

    if (isDeliver) {
      if (deliveredIncomplete) {
        return;
      }
      // Fix 2 — le champ est préempli avec scheduled_for (defaultDelivered), donc
      // valider sans y toucher NE DOIT PAS envoyer p_delivered_at : la RPC valide
      // toute date explicitement transmise (jamais dans le futur, jamais avant la
      // création), une validation que le coalesce SQL (p_delivered_at, scheduled_for,
      // now()) ne fait PAS quand p_delivered_at est absent. Renvoyer verbatim la
      // valeur préremplie rejetterait par exemple une commande programmée pour plus
      // tard et livrée par erreur en avance. Seule une édition RÉELLE de l'agent est
      // transmise.
      const deliveredEdited =
        deliveredDate !== defaultDelivered.date || deliveredTime !== defaultDelivered.time;
      const deliveredAt = deliveredEdited
        ? optionalDateTimeIso(deliveredDate, deliveredTime)
        : null;
      onConfirm(deliveredAt ? { deliveredAt } : {});
      return;
    }

    if (isCancel) {
      if (reasons.size === 0) {
        return;
      }
      onConfirm({
        cancelReasons: [...reasons],
        ...(reasons.has('autres') && note.trim() ? { note: note.trim() } : {}),
      });
      return;
    }

    const scheduledFor = dateTimeInputsToIso(date, time);
    if (!scheduledFor) {
      return;
    }
    onConfirm({ scheduledFor });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <dialog
        aria-label={title}
        aria-modal="true"
        className="m-0 w-full max-w-sm space-y-4 rounded-lg border border-border bg-surface p-5 text-text shadow-2"
        open
      >
        <h2 className="text-lg font-semibold">{title}</h2>

        {isAssign ? (
          hasNoDrivers ? (
            <p className="text-sm text-muted">
              Aucun livreur actif. Ajoutez-en un dans Paramètres &gt; Équipe.
            </p>
          ) : (
            <div className="space-y-2">
              <Label htmlFor={fieldId}>Livreur</Label>
              <select
                className="h-12 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text shadow-1 transition focus:border-accent"
                id={fieldId}
                onChange={(event) => setDriverId(event.target.value)}
                value={driverId}
              >
                <option value="">Choisir un livreur…</option>
                {drivers.map((driver) => (
                  <option key={driver.id} value={driver.id}>
                    {driver.fullName}
                  </option>
                ))}
              </select>
              <StockShortageWarning checkFailed={stockCheckFailed} shortages={stockShortages} />
            </div>
          )
        ) : isCancel ? (
          <div className="space-y-3">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-text">Raison(s) de l'annulation</legend>
              {cancelReasonValues.map((reason) => (
                <label
                  className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 text-sm text-text hover:bg-canvas"
                  key={reason}
                >
                  <input
                    checked={reasons.has(reason)}
                    className="size-4"
                    onChange={() => toggleReason(reason)}
                    type="checkbox"
                  />
                  {cancelReasonLabels[reason]}
                </label>
              ))}
            </fieldset>

            {reasons.has('autres') ? (
              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-note`}>Précision (optionnel)</Label>
                <Input
                  className="h-12"
                  id={`${fieldId}-note`}
                  maxLength={500}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Détail de la raison…"
                  type="text"
                  value={note}
                />
              </div>
            ) : null}

            {reasons.size === 0 ? (
              <p className="text-sm text-muted">Sélectionnez au moins une raison.</p>
            ) : null}
          </div>
        ) : isDeliver ? (
          // 0114 — « Marquer livrée » n'avait AUCUN dialog avant ce lot : le clic
          // exécutait la transition directement. Fix 2 — le champ est préempli avec
          // la date de livraison prévue (order.scheduled_for) quand elle existe, pour
          // que l'agent voie la date réellement utilisée et puisse la corriger en
          // connaissance de cause ; vide si la commande n'a jamais été programmée.
          <div className="space-y-3">
            <p className="text-sm text-muted">
              {orderScheduledFor
                ? 'La livraison sera datée du jour programmé ci-dessous. Modifiez-le si elle a eu lieu à une autre date.'
                : "La livraison sera datée d'aujourd'hui. Renseignez ces champs uniquement si elle a réellement eu lieu à une autre date."}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-delivered-date`}>Date de livraison réelle</Label>
                <Input
                  className="h-12"
                  data-testid="transition-delivered-date"
                  id={`${fieldId}-delivered-date`}
                  onChange={(event) => setDeliveredDate(event.target.value)}
                  type="date"
                  value={deliveredDate}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-delivered-time`}>Heure</Label>
                <Input
                  className="h-12"
                  data-testid="transition-delivered-time"
                  id={`${fieldId}-delivered-time`}
                  onChange={(event) => setDeliveredTime(normalizeHourInput(event.target.value))}
                  step={3600}
                  type="time"
                  value={deliveredTime}
                />
              </div>
            </div>
            {deliveredIncomplete ? (
              <p className="text-sm text-danger" role="alert">
                Renseignez la date ET l'heure, ou laissez les deux vides.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={fieldId}>Date de livraison</Label>
                <Input
                  className="h-12"
                  id={fieldId}
                  onChange={(event) => setDate(event.target.value)}
                  type="date"
                  value={date}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-time`}>Heure de livraison</Label>
                <Input
                  className="h-12"
                  id={`${fieldId}-time`}
                  onChange={(event) => setTime(normalizeHourInput(event.target.value))}
                  step={3600}
                  type="time"
                  value={time}
                />
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button className="min-h-12" onClick={onCancel} size="sm" type="button" variant="ghost">
            Fermer
          </Button>
          <Button
            className="min-h-12"
            disabled={!canConfirm || isSubmitting}
            onClick={handleConfirm}
            size="sm"
            type="button"
            variant={isCancel ? 'destructive' : 'primary'}
          >
            {isCancel ? "Confirmer l'annulation" : 'Valider'}
          </Button>
        </div>
      </dialog>
    </div>
  );
}
