'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getOrderAmountsForAssignmentAction, updateOrderAmountsAction } from '@/lib/actions/orders';
import { type TransitionResult, performTransition } from '@/lib/actions/transitions';
import { dateTimeInputsToIso, isoToDateTimeInputs } from '@/lib/format/datetime-input';
import { formatMoney } from '@/lib/format/fcfa';
import { useAction } from 'next-safe-action/hooks';
import { useEffect, useId, useState } from 'react';

type TransitionSuccess = Extract<TransitionResult, { ok: true }>;

type AssignmentDetailsDialogProps = {
  onClose: () => void;
  // Appelé après le passage en livraison réussi (save montants + demarrer_livraison),
  // avec le résultat de transition pour mettre à jour la liste/le détail.
  onConfirmed: (result: TransitionSuccess) => void;
  orderId: string;
};

// Phase 11.1 (option C) — popup d'assignation : s'ouvre APRÈS le choix du livreur
// (et à la réouverture d'une commande assignée). Affiche les détails (lecture) +
// les montants modifiables. « Confirmer et démarrer la livraison » = save montants
// (si modifié) → transition demarrer_livraison (assigned → out_for_delivery) →
// fermeture. Annuler/Échap → la commande reste assignée (vue « Programmer »).
export function AssignmentDetailsDialog({
  onClose,
  onConfirmed,
  orderId,
}: AssignmentDetailsDialogProps) {
  const fieldId = useId();
  const fetchDetails = useAction(getOrderAmountsForAssignmentAction);
  const update = useAction(updateOrderAmountsAction);
  const startDelivery = useAction(performTransition);

  const [loaded, setLoaded] = useState(false);
  const [orderNumber, setOrderNumber] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [items, setItems] = useState<{ title: string; quantity: number; price: number }[]>([]);
  const [savedTotal, setSavedTotal] = useState(0);
  const [savedFee, setSavedFee] = useState(0);
  const [savedScheduledFor, setSavedScheduledFor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [fee, setFee] = useState(0);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  const isExecuting = update.isExecuting || startDelivery.isExecuting;

  // Chargement initial des montants/détails (la LISTE ne porte pas delivery_fee_minor).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await fetchDetails.executeAsync({ orderId });
      if (cancelled) {
        return;
      }
      if (!result?.data?.ok) {
        setFeedback('Impossible de charger les détails de la commande.');
        return;
      }
      const d = result.data.data;
      setOrderNumber(d.orderNumber);
      setCustomerName(d.customerName);
      setCurrency(d.currency);
      setItems(d.items);
      setSavedTotal(d.totalAmount);
      setSavedFee(d.deliveryFeeMinor);
      setSavedScheduledFor(d.scheduledFor);
      setTotal(d.totalAmount);
      setFee(d.deliveryFeeMinor);
      const dt = isoToDateTimeInputs(d.scheduledFor);
      setDate(dt.date);
      setTime(dt.time);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
    // orderId stable pour la durée de vie du popup ; executeAsync mémoïsé (next-safe-action v8).
  }, [orderId, fetchDetails.executeAsync]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !isExecuting) {
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isExecuting, onClose]);

  const netMinor = Math.max(total - fee, 0);
  const totalValid = Number.isFinite(total) && total >= 0;
  const feeValid = Number.isFinite(fee) && fee >= 0;
  const canConfirm = loaded && totalValid && feeValid && !isExecuting;

  async function handleConfirm() {
    if (!canConfirm) {
      return;
    }
    setFeedback(null);

    const roundedTotal = Math.round(total);
    const roundedFee = Math.round(fee);
    const scheduledForIso = dateTimeInputsToIso(date, time);
    const amountsChanged =
      roundedTotal !== savedTotal ||
      roundedFee !== savedFee ||
      (scheduledForIso !== null && scheduledForIso !== savedScheduledFor);

    if (amountsChanged) {
      const saved = await update.executeAsync({
        orderId,
        totalAmount: roundedTotal,
        deliveryFeeMinor: roundedFee,
        ...(scheduledForIso ? { scheduledFor: scheduledForIso } : {}),
      });
      if (!saved?.data?.ok) {
        setFeedback('La mise à jour des montants a échoué.');
        return;
      }
    }

    const started = await startDelivery.executeAsync({ orderId, action: 'demarrer_livraison' });
    if (!started?.data?.ok) {
      const message =
        started?.data && 'message' in started.data && typeof started.data.message === 'string'
          ? started.data.message
          : 'Le passage en livraison a échoué.';
      setFeedback(message);
      return;
    }

    onConfirmed(started.data);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <dialog
        aria-label="Détails de la livraison"
        aria-modal="true"
        className="m-0 max-h-[90dvh] w-full max-w-md space-y-4 overflow-y-auto rounded-lg border border-border bg-surface p-5 text-text shadow-2"
        open
      >
        <header className="space-y-1">
          <h2 className="text-lg font-semibold">Détails de la livraison</h2>
          <p className="text-sm text-muted">
            {(orderNumber ?? '—') + (customerName ? ` · ${customerName}` : '')}
          </p>
        </header>

        {!loaded ? (
          <p className="py-6 text-center text-sm text-muted">Chargement…</p>
        ) : (
          <>
            {items.length > 0 ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {items.map((item, index) => (
                  <li
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                    key={`${item.title}-${index}`}
                  >
                    <span className="min-w-0 truncate">
                      {item.quantity} × {item.title || '—'}
                    </span>
                    <span className="shrink-0 font-mono tabular-nums">
                      {formatMoney(item.quantity * item.price, currency)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-total`}>Total</Label>
              <Input
                id={`${fieldId}-total`}
                inputMode="numeric"
                min={0}
                onChange={(event) => setTotal(Number(event.target.value))}
                type="number"
                value={Number.isFinite(total) ? total : ''}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-fee`}>Frais de livraison</Label>
              <Input
                id={`${fieldId}-fee`}
                inputMode="numeric"
                min={0}
                onChange={(event) => setFee(Number(event.target.value))}
                type="number"
                value={Number.isFinite(fee) ? fee : ''}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-date`}>Date de livraison</Label>
                <Input
                  id={`${fieldId}-date`}
                  onChange={(event) => setDate(event.target.value)}
                  type="date"
                  value={date}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-time`}>Heure de livraison</Label>
                <Input
                  id={`${fieldId}-time`}
                  onChange={(event) => setTime(event.target.value)}
                  type="time"
                  value={time}
                />
              </div>
            </div>

            <p className="text-sm text-muted">
              Net (hors livraison) :{' '}
              <span className="font-mono font-semibold tabular-nums text-text">
                {formatMoney(netMinor, currency)}
              </span>
            </p>
          </>
        )}

        {feedback ? (
          <p className="text-sm font-medium text-danger" role="alert">
            {feedback}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button disabled={isExecuting} onClick={onClose} size="sm" type="button" variant="ghost">
            Annuler
          </Button>
          <Button
            disabled={!canConfirm}
            onClick={handleConfirm}
            size="sm"
            type="button"
            variant="primary"
          >
            Confirmer et démarrer la livraison
          </Button>
        </div>
      </dialog>
    </div>
  );
}
