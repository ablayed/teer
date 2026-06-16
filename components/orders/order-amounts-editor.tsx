'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { updateOrderAmountsAction } from '@/lib/actions/orders';
import { formatMoney } from '@/lib/format/fcfa';
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
  // Panneau post-assignation : ouvert d'emblée quand la commande est assignée
  // (spec — « afficher directement les détails modifiables »).
  const [open, setOpen] = useState(deliveryState === 'assigned');
  const [total, setTotal] = useState(totalAmount);
  const [fee, setFee] = useState(deliveryFeeMinor);
  const initialDateTime = isoToDateTimeInputs(scheduledFor);
  const [date, setDate] = useState(initialDateTime.date);
  const [time, setTime] = useState(initialDateTime.time);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(
    null,
  );

  useEffect(() => {
    const result = update.result.data;
    if (!result) {
      return;
    }
    if (result.ok) {
      setFeedback({ tone: 'success', message: 'Montants mis à jour.' });
      setOpen(false);
      router.refresh();
      return;
    }
    setFeedback({ tone: 'error', message: 'La mise à jour a échoué.' });
  }, [router, update.result.data]);

  const netMinor = Math.max(total - fee, 0);
  const totalValid = Number.isFinite(total) && total >= 0;
  const feeValid = Number.isFinite(fee) && fee >= 0;
  const canConfirm = totalValid && feeValid && !update.isExecuting;

  function handleConfirm() {
    if (!canConfirm) {
      return;
    }
    setFeedback(null);
    const scheduledForIso = showScheduling ? dateTimeInputsToIso(date, time) : null;
    update.execute({
      orderId,
      totalAmount: Math.round(total),
      deliveryFeeMinor: Math.round(fee),
      ...(scheduledForIso ? { scheduledFor: scheduledForIso } : {}),
    });
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase text-muted">
          {deliveryState === 'assigned' ? 'Détails de la livraison' : 'Montants'}
        </h2>
        {open ? null : (
          <Button
            className="min-h-10"
            onClick={() => {
              setFeedback(null);
              setOpen(true);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Pencil aria-hidden="true" className="mr-1 size-4" />
            Modifier
          </Button>
        )}
      </div>

      {open ? (
        <div className="space-y-3 rounded-lg border border-border p-4">
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

          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                setOpen(false);
                setFeedback(null);
                setTotal(totalAmount);
                setFee(deliveryFeeMinor);
                setDate(initialDateTime.date);
                setTime(initialDateTime.time);
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
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border p-4">
            <p className="text-sm text-muted">Total</p>
            <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
              {formatMoney(totalAmount, currency)}
            </p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-sm text-muted">Frais de livraison</p>
            <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
              {formatMoney(deliveryFeeMinor, currency)}
            </p>
          </div>
        </div>
      )}

      {feedback ? (
        <p
          className={`text-sm font-medium ${feedback.tone === 'success' ? 'text-success' : 'text-danger'}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </p>
      ) : null}
    </section>
  );
}
