'use client';

import { Button } from '@/components/ui/button';
import { logCallAction } from '@/lib/actions/orders';
import {
  type CallOutcome,
  callOutcomes,
  callRescheduleMessages,
  validateCallNextActionAt,
} from '@/lib/orders/call-log-validation';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';

type CallLogDialogProps = {
  onClose: () => void;
  orderId: string;
};

const outcomeLabels: Record<CallOutcome, string> = {
  CONFIRMEE: 'Confirmée',
  SANS_REPONSE: 'Sans réponse',
  A_RAPPELER: 'À rappeler',
  REFUSEE: 'Refusée',
};

function errorMessage(errorCode: string | undefined): string {
  switch (errorCode) {
    case 'audit_failed':
      return "L'appel est enregistré, mais l'audit a échoué.";
    case 'call_log_failed':
      return "L'appel n'a pas pu être enregistré.";
    case 'order_not_found':
      return 'Commande introuvable.';
    default:
      return 'Une erreur est survenue. Réessayez.';
  }
}

// Journalisation d'appel portee par le dropdown d'actions (remplace l'ancien
// bloc Appel du detail). Auto-contenu : possede sa propre action serveur.
export function CallLogDialog({ onClose, orderId }: CallLogDialogProps) {
  const router = useRouter();
  const fieldId = useId();
  const logCall = useAction(logCallAction);
  const [outcome, setOutcome] = useState<CallOutcome>('SANS_REPONSE');
  const [note, setNote] = useState('');
  const [nextActionAt, setNextActionAt] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const result = logCall.result.data;

    if (!result) {
      return;
    }

    if (result.ok) {
      router.refresh();
      onClose();
      return;
    }

    setFeedback(errorMessage('errorCode' in result ? result.errorCode : undefined));
  }, [logCall.result.data, onClose, router]);

  function submit() {
    setFeedback(null);

    let nextActionAtIso: string | undefined;

    if (outcome === 'A_RAPPELER') {
      const validation = validateCallNextActionAt(nextActionAt);
      if (!validation.ok) {
        setFeedback(validation.message);
        return;
      }
      nextActionAtIso = validation.iso;
    }

    logCall.execute({
      orderId,
      outcome,
      note: note.trim() || undefined,
      nextActionAt: nextActionAtIso,
    });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <dialog
        aria-label="Journaliser un appel"
        aria-modal="true"
        className="m-0 w-full max-w-sm space-y-4 rounded-lg border border-border bg-surface p-5 text-text shadow-2"
        open
      >
        <h2 className="text-lg font-semibold">Journaliser un appel</h2>

        <fieldset className="space-y-2">
          <legend className="sr-only">Résultat de l'appel</legend>
          <div className="grid grid-cols-2 gap-2">
            {callOutcomes.map((callOutcome) => (
              <label
                className={`inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border px-3 text-center text-sm font-medium ${
                  outcome === callOutcome
                    ? 'border-accent bg-accent text-[#111]'
                    : 'border-border bg-surface text-text hover:bg-canvas'
                }`}
                key={callOutcome}
              >
                <input
                  checked={outcome === callOutcome}
                  className="sr-only"
                  name="call-outcome"
                  onChange={() => setOutcome(callOutcome)}
                  type="radio"
                  value={callOutcome}
                />
                {outcomeLabels[callOutcome]}
              </label>
            ))}
          </div>
        </fieldset>

        {outcome === 'A_RAPPELER' ? (
          <label className="block space-y-2 text-sm font-medium" htmlFor={`${fieldId}-reschedule`}>
            <span>Date et heure du rappel</span>
            <input
              aria-describedby={`${fieldId}-hint`}
              className="h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
              id={`${fieldId}-reschedule`}
              onChange={(event) => setNextActionAt(event.target.value)}
              type="datetime-local"
              value={nextActionAt}
            />
            <span className="block text-xs text-muted" id={`${fieldId}-hint`}>
              {callRescheduleMessages.required}
            </span>
          </label>
        ) : null}

        <label className="block space-y-2 text-sm font-medium" htmlFor={`${fieldId}-note`}>
          <span>Note</span>
          <textarea
            className="min-h-24 w-full resize-none rounded-lg border border-border bg-surface p-3 text-sm outline-none focus:border-accent"
            id={`${fieldId}-note`}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
            value={note}
          />
          <span className="block text-right text-xs text-muted">{note.length}/500</span>
        </label>

        {feedback ? (
          <p className="text-sm font-medium text-danger" role="alert">
            {feedback}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose} size="sm" type="button" variant="ghost">
            Fermer
          </Button>
          <Button
            disabled={logCall.isExecuting}
            onClick={submit}
            size="sm"
            type="button"
            variant="primary"
          >
            {logCall.isExecuting ? 'Enregistrement...' : "Enregistrer l'appel"}
          </Button>
        </div>
      </dialog>
    </div>
  );
}
