'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  type CancelReason,
  cancelReasonLabels,
  cancelReasonValues,
} from '@/lib/domain/order-transition-actions';
import { useEffect, useId, useState } from 'react';

export type DriverOption = { id: string; fullName: string };

// Actions qui nécessitent une saisie avant que la transition ne s'exécute.
export type PayloadDialogAction = 'assigner' | 'programmer' | 'annuler';

export type TransitionPayload = {
  assignedDriverId?: string;
  scheduledFor?: string;
  cancelReasons?: CancelReason[];
  note?: string;
};

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

// Phase 11 : la programmation expose seulement une date. On convertit en ISO
// avec une heure fixe au milieu de journée pour éviter les décalages de fuseau.
function dateInputToIso(dateValue: string): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  if (!dateMatch) {
    return null;
  }

  const [, year, month, day] = dateMatch;
  const date = new Date(Number(year), Number(month) - 1, Number(day), 12, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const dialogTitles: Record<PayloadDialogAction, string> = {
  assigner: 'Assigner à un livreur',
  programmer: 'Programmer la livraison',
  annuler: 'Annuler la commande',
};

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
  const [reasons, setReasons] = useState<Set<CancelReason>>(new Set());
  const [note, setNote] = useState('');

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
  const title = dialogTitles[action];
  const hasNoDrivers = isAssign && drivers.length === 0;

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

  const canConfirm = isAssign
    ? Boolean(driverId)
    : isCancel
      ? reasons.size > 0
      : Boolean(dateInputToIso(date));

  function handleConfirm() {
    if (isAssign) {
      if (!driverId) {
        return;
      }
      onConfirm({ assignedDriverId: driverId });
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
        ) : isCancel ? (
          <div className="space-y-3">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-text">Raison(s) de l'annulation</legend>
              {cancelReasonValues.map((reason) => (
                <label
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 text-sm text-text hover:bg-canvas"
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
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor={fieldId}>Date de livraison</Label>
              <Input
                id={fieldId}
                onChange={(event) => setDate(event.target.value)}
                type="date"
                value={date}
              />
            </div>
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
            variant={isCancel ? 'destructive' : 'primary'}
          >
            {isCancel ? "Confirmer l'annulation" : 'Valider'}
          </Button>
        </div>
      </dialog>
    </div>
  );
}
