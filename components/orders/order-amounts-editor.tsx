'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { updateOrderAmountsAction } from '@/lib/actions/orders';
import { performTransition } from '@/lib/actions/transitions';
import { formatMoney } from '@/lib/format/fcfa';
import { Pencil } from 'lucide-react';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

type OrderAmountsEditorProps = {
  currency: string | null;
  customerName: string | null;
  deliveryFeeMinor: number;
  deliveryState: string | null;
  orderId: string;
  orderNumber: string | null;
  scheduledFor: string | null;
  totalAmount: number;
};

// Les états de livraison où une date/heure de livraison est pertinente (programmée
// ou déjà dispatchée) → on propose l'édition date+heure dans le panneau.
const SCHEDULING_STATES = ['scheduled', 'assigned', 'out_for_delivery'];

function pad(value: number): string {
  return `${value}`.padStart(2, '0');
}

function isoToDateTimeInputs(iso: string | null): { date: string; time: string } {
  if (!iso) {
    return { date: '', time: '' };
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return { date: '', time: '' };
  }
  return {
    date: `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`,
    time: `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`,
  };
}

function dateTimeInputsToIso(date: string, time: string): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) {
    return null;
  }
  const built = new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    0,
  );
  return Number.isNaN(built.getTime()) ? null : built.toISOString();
}

export function OrderAmountsEditor({
  currency,
  customerName,
  deliveryFeeMinor,
  deliveryState,
  orderId,
  orderNumber,
  scheduledFor,
  totalAmount,
}: OrderAmountsEditorProps) {
  const fieldId = useId();
  const router = useRouter();
  const update = useAction(updateOrderAmountsAction);
  const startDelivery = useAction(performTransition);

  const isAssigned = deliveryState === 'assigned';
  const showScheduling = deliveryState !== null && SCHEDULING_STATES.includes(deliveryState);
  // Popup d'assignation : modal ouvert d'emblée quand la commande est assignée
  // (option C — « afficher directement les détails modifiables avant la livraison »).
  const [open, setOpen] = useState(isAssigned);
  // Valeurs affichées dans les cartes résumé : état local pour refléter une sauvegarde
  // sans dépendre de router.refresh() (cf. staleness ~25% en prod build).
  const [displayedTotal, setDisplayedTotal] = useState(totalAmount);
  const [displayedFee, setDisplayedFee] = useState(deliveryFeeMinor);
  const [total, setTotal] = useState(totalAmount);
  const [fee, setFee] = useState(deliveryFeeMinor);
  const initialDateTime = isoToDateTimeInputs(scheduledFor);
  const [date, setDate] = useState(initialDateTime.date);
  const [time, setTime] = useState(initialDateTime.time);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(
    null,
  );

  const isExecuting = update.isExecuting || startDelivery.isExecuting;

  // Ouverture automatique du popup quand la commande PASSE à « assigned » en cours
  // de page (assignation in-place sur le détail) — le useState initial ne couvre
  // que le montage (navigation vers une commande déjà assignée). Le ref évite la
  // réouverture après confirmation (assigned → out_for_delivery) et sur les
  // re-rendus router.refresh() où delivery_state ne change pas.
  const prevDeliveryState = useRef(deliveryState);
  useEffect(() => {
    if (deliveryState === 'assigned' && prevDeliveryState.current !== 'assigned') {
      setOpen(true);
      setFeedback(null);
    }
    prevDeliveryState.current = deliveryState;
  }, [deliveryState]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      // Échap ferme sans sauvegarder (les champs sont réinitialisés à la
      // réouverture via « Modifier »). Bloqué pendant une exécution en cours.
      if (event.key === 'Escape' && !isExecuting) {
        setOpen(false);
        setFeedback(null);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, isExecuting]);

  const netMinor = Math.max(total - fee, 0);
  const totalValid = Number.isFinite(total) && total >= 0;
  const feeValid = Number.isFinite(fee) && fee >= 0;
  const canConfirm = totalValid && feeValid && !isExecuting;

  function resetFields() {
    setTotal(displayedTotal);
    setFee(displayedFee);
    setDate(initialDateTime.date);
    setTime(initialDateTime.time);
  }

  function closeModal() {
    setOpen(false);
    setFeedback(null);
    resetFields();
  }

  async function handleConfirm() {
    if (!canConfirm) {
      return;
    }
    setFeedback(null);

    const roundedTotal = Math.round(total);
    const roundedFee = Math.round(fee);
    const scheduledForIso = showScheduling ? dateTimeInputsToIso(date, time) : null;
    const amountsChanged =
      roundedTotal !== displayedTotal ||
      roundedFee !== displayedFee ||
      (scheduledForIso !== null && scheduledForIso !== scheduledFor);

    // 1) Sauvegarde des montants (et date/heure) UNIQUEMENT si un champ a changé.
    if (amountsChanged) {
      const result = await update.executeAsync({
        orderId,
        totalAmount: roundedTotal,
        deliveryFeeMinor: roundedFee,
        ...(scheduledForIso ? { scheduledFor: scheduledForIso } : {}),
      });
      if (!result?.data?.ok) {
        setFeedback({ tone: 'error', message: 'La mise à jour des montants a échoué.' });
        return;
      }
      setDisplayedTotal(roundedTotal);
      setDisplayedFee(roundedFee);
    }

    // 2) Passage en livraison : assigned → out_for_delivery (aucun mouvement stock).
    if (isAssigned) {
      const result = await startDelivery.executeAsync({
        orderId,
        action: 'demarrer_livraison',
      });
      if (!result?.data?.ok) {
        const message =
          result?.data && 'message' in result.data && typeof result.data.message === 'string'
            ? result.data.message
            : 'Le passage en livraison a échoué.';
        setFeedback({ tone: 'error', message });
        return;
      }
    }

    setOpen(false);
    setFeedback({
      tone: 'success',
      message: isAssigned ? 'Commande en cours de livraison.' : 'Montants mis à jour.',
    });
    router.refresh();
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase text-muted">Montants</h2>
        <Button
          className="min-h-10"
          onClick={() => {
            setFeedback(null);
            resetFields();
            setOpen(true);
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Pencil aria-hidden="true" className="mr-1 size-4" />
          Modifier
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border p-4">
          <p className="text-sm text-muted">Total</p>
          <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
            {formatMoney(displayedTotal, currency)}
          </p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <p className="text-sm text-muted">Frais de livraison</p>
          <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
            {formatMoney(displayedFee, currency)}
          </p>
        </div>
      </div>

      {feedback ? (
        <p
          className={`text-sm font-medium ${feedback.tone === 'success' ? 'text-success' : 'text-danger'}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </p>
      ) : null}

      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
          <dialog
            aria-label={isAssigned ? 'Détails de la livraison' : 'Modifier les montants'}
            aria-modal="true"
            className="m-0 max-h-[90dvh] w-full max-w-md space-y-4 overflow-y-auto rounded-lg border border-border bg-surface p-5 text-text shadow-2"
            open
          >
            <header className="space-y-1">
              <h2 className="text-lg font-semibold">
                {isAssigned ? 'Détails de la livraison' : 'Modifier les montants'}
              </h2>
              <p className="text-sm text-muted">
                {(orderNumber ?? '—') + (customerName ? ` · ${customerName}` : '')}
              </p>
            </header>

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

            {showScheduling ? (
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
            ) : null}

            <p className="text-sm text-muted">
              Net (hors livraison) :{' '}
              <span className="font-mono font-semibold tabular-nums text-text">
                {formatMoney(netMinor, currency)}
              </span>
            </p>

            {feedback?.tone === 'error' ? (
              <p className="text-sm font-medium text-danger" role="alert">
                {feedback.message}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button
                disabled={isExecuting}
                onClick={closeModal}
                size="sm"
                type="button"
                variant="ghost"
              >
                Annuler
              </Button>
              <Button
                disabled={!canConfirm}
                onClick={handleConfirm}
                size="sm"
                type="button"
                variant="primary"
              >
                {isAssigned ? 'Confirmer et démarrer la livraison' : 'Confirmer'}
              </Button>
            </div>
          </dialog>
        </div>
      ) : null}
    </section>
  );
}
