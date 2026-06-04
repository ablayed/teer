'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useEffect, useId, useState } from 'react';

export type DriverOption = { id: string; fullName: string };

// Only these two actions need an extra input before the transition runs.
export type PayloadDialogAction = 'assigner' | 'programmer';

export type TransitionPayload = { assignedDriverId?: string; scheduledFor?: string };

type TransitionDialogProps = {
  action: PayloadDialogAction;
  drivers: DriverOption[];
  isSubmitting: boolean;
  onCancel: () => void;
  onConfirm: (payload: TransitionPayload) => void;
};

function todayInputValue(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

// A <input type="date"> yields a local YYYY-MM-DD. We anchor it at local noon so
// the resulting UTC instant lands on the same calendar day for any real timezone
// (the "À livrer aujourd'hui" view compares scheduled_for::date to today).
function dateInputToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), 12, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function TransitionDialog({
  action,
  drivers,
  isSubmitting,
  onCancel,
  onConfirm,
}: TransitionDialogProps) {
  const fieldId = useId();
  const [driverId, setDriverId] = useState('');
  const [date, setDate] = useState(todayInputValue);

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
  const title = isAssign ? 'Assigner à un livreur' : 'Programmer la livraison';
  const hasNoDrivers = isAssign && drivers.length === 0;
  const canConfirm = isAssign ? Boolean(driverId) : Boolean(dateInputToIso(date));

  function handleConfirm() {
    if (isAssign) {
      if (!driverId) {
        return;
      }

      onConfirm({ assignedDriverId: driverId });
      return;
    }

    const scheduledFor = dateInputToIso(date);
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
                className="h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text shadow-1 transition focus:border-accent"
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
            </div>
          )
        ) : (
          <div className="space-y-2">
            <Label htmlFor={fieldId}>Date de livraison</Label>
            <Input
              id={fieldId}
              onChange={(event) => setDate(event.target.value)}
              type="date"
              value={date}
            />
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} size="sm" type="button" variant="ghost">
            Fermer
          </Button>
          <Button
            disabled={!canConfirm || isSubmitting}
            onClick={handleConfirm}
            size="sm"
            type="button"
            variant="primary"
          >
            Valider
          </Button>
        </div>
      </dialog>
    </div>
  );
}
