'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { updateOrderAmountsAction } from '@/lib/actions/orders';
import {
  dateTimeInputsToIso,
  isoToDateTimeInputs,
  normalizeHourInput,
} from '@/lib/format/datetime-input';
import { formatMoney } from '@/lib/format/fcfa';
import {
  ORDER_TOTAL_POSITIVE_MESSAGE,
  parsePositiveOrderTotalInput,
} from '@/lib/orders/order-amount-validation';
import { Pencil } from 'lucide-react';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';

type OrderAmountsEditorProps = {
  currency: string | null;
  deliveryFeeMinor: number;
  deliveryState: string | null;
  orderId: string;
  scheduledFor: string | null;
  totalAmount: number;
};

// Phase 11.1 : éditeur de montants (total + frais de livraison + date/heure) — un
// modal ouvert via « Modifier ». PAS de transition d'état (le passage en livraison
// est géré par le popup d'assignation). Sert la consultation/édition à tout moment
// (programmée, en cours de livraison…). owner/manager (gating amont canEditAmounts).

// États de livraison où une date/heure de livraison est pertinente.
const SCHEDULING_STATES = ['scheduled', 'assigned', 'out_for_delivery'];

export function OrderAmountsEditor({
  currency,
  deliveryFeeMinor,
  deliveryState,
  orderId,
  scheduledFor,
  totalAmount,
}: OrderAmountsEditorProps) {
  const fieldId = useId();
  const router = useRouter();
  const update = useAction(updateOrderAmountsAction);

  const showScheduling = deliveryState !== null && SCHEDULING_STATES.includes(deliveryState);
  const [open, setOpen] = useState(false);
  const [displayedTotal, setDisplayedTotal] = useState(totalAmount);
  const [displayedFee, setDisplayedFee] = useState(deliveryFeeMinor);
  const [totalInput, setTotalInput] = useState(String(totalAmount));
  const [fee, setFee] = useState(deliveryFeeMinor);
  const initialDateTime = isoToDateTimeInputs(scheduledFor);
  const [date, setDate] = useState(initialDateTime.date);
  const [time, setTime] = useState(normalizeHourInput(initialDateTime.time));
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(
    null,
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !update.isExecuting) {
        setOpen(false);
        setFeedback(null);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, update.isExecuting]);

  const parsedTotal = parsePositiveOrderTotalInput(totalInput);
  const netMinor = Math.max((parsedTotal ?? 0) - fee, 0);
  const totalValid = parsedTotal !== null;
  const feeValid = Number.isFinite(fee) && fee >= 0;
  const canConfirm = totalValid && feeValid && !update.isExecuting;

  function resetFields() {
    setTotalInput(String(displayedTotal));
    setFee(displayedFee);
    setDate(initialDateTime.date);
    setTime(initialDateTime.time);
  }

  async function handleConfirm() {
    if (!canConfirm) {
      return;
    }
    setFeedback(null);

    if (parsedTotal === null) {
      setFeedback({ tone: 'error', message: ORDER_TOTAL_POSITIVE_MESSAGE });
      return;
    }

    const roundedTotal = Math.round(parsedTotal);
    const roundedFee = Math.round(fee);
    const scheduledForIso = showScheduling ? dateTimeInputsToIso(date, time) : null;

    const result = await update.executeAsync({
      orderId,
      totalAmount: roundedTotal,
      deliveryFeeMinor: roundedFee,
      ...(scheduledForIso ? { scheduledFor: scheduledForIso } : {}),
    });

    if (!result?.data?.ok) {
      setFeedback({ tone: 'error', message: 'La mise à jour a échoué.' });
      return;
    }

    setDisplayedTotal(roundedTotal);
    setDisplayedFee(roundedFee);
    setOpen(false);
    setFeedback({ tone: 'success', message: 'Montants mis à jour.' });
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
            aria-label="Modifier les montants"
            aria-modal="true"
            className="m-0 max-h-[90dvh] w-full max-w-md space-y-4 overflow-y-auto rounded-lg border border-border bg-surface p-5 text-text shadow-2"
            open
          >
            <h2 className="text-lg font-semibold">Modifier les montants</h2>

            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-total`}>Total</Label>
              <Input
                id={`${fieldId}-total`}
                inputMode="numeric"
                min={1}
                onChange={(event) => setTotalInput(event.target.value)}
                type="number"
                value={totalInput}
              />
              {!totalValid ? (
                <p className="text-sm text-danger" role="alert">
                  {ORDER_TOTAL_POSITIVE_MESSAGE}
                </p>
              ) : null}
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
                    onChange={(event) => setTime(normalizeHourInput(event.target.value))}
                    step={3600}
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
                disabled={update.isExecuting}
                onClick={() => {
                  setOpen(false);
                  setFeedback(null);
                  resetFields();
                }}
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
                Confirmer
              </Button>
            </div>
          </dialog>
        </div>
      ) : null}
    </section>
  );
}
