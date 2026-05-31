'use client';

import { Button } from '@/components/ui/button';
import { type OrderTimelineEvent, logCallAction } from '@/lib/actions/orders';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

type CallOutcome = 'CONFIRMEE' | 'SANS_REPONSE' | 'A_RAPPELER' | 'REFUSEE';

type CallLogFormProps = {
  onOptimisticCall: (event: OrderTimelineEvent) => void;
  onRemoveOptimisticCall: (eventId: string) => void;
  orderId: string;
};

const callOutcomes: CallOutcome[] = ['CONFIRMEE', 'SANS_REPONSE', 'A_RAPPELER', 'REFUSEE'];

const outcomeLabels: Record<CallOutcome, string> = {
  CONFIRMEE: 'Confirmee',
  SANS_REPONSE: 'Sans reponse',
  A_RAPPELER: 'A rappeler',
  REFUSEE: 'Refusee',
};

function toDatetimeIso(value: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function errorMessage(errorCode: string | undefined): string {
  switch (errorCode) {
    case 'audit_failed':
      return "L'appel est enregistre, mais l'audit a echoue.";
    case 'call_log_failed':
      return "L'appel n'a pas pu etre enregistre.";
    case 'order_not_found':
      return 'Commande introuvable.';
    default:
      return 'Une erreur est survenue. Reessayez.';
  }
}

export function CallLogForm({
  onOptimisticCall,
  onRemoveOptimisticCall,
  orderId,
}: CallLogFormProps) {
  const router = useRouter();
  const logCall = useAction(logCallAction);
  const [outcome, setOutcome] = useState<CallOutcome>('SANS_REPONSE');
  const [note, setNote] = useState('');
  const [nextActionAt, setNextActionAt] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'success'; message: string } | null>(
    null,
  );
  const [optimisticEventId, setOptimisticEventId] = useState<string | null>(null);
  const noteLength = note.length;

  const result = logCall.result.data;
  const validationError = logCall.result.validationErrors ? 'Verifiez les champs.' : null;

  const actionError = useMemo(() => {
    if (!result || result.ok) {
      return null;
    }

    return errorMessage('errorCode' in result ? result.errorCode : undefined);
  }, [result]);

  useEffect(() => {
    if (result?.ok) {
      setFeedback({ tone: 'success', message: 'Appel enregistre.' });
      setNote('');
      setNextActionAt('');
      router.refresh();
      return;
    }

    const message = actionError ?? validationError;

    if (message) {
      if (optimisticEventId) {
        onRemoveOptimisticCall(optimisticEventId);
        setOptimisticEventId(null);
      }

      setFeedback({ tone: 'error', message });
    }
  }, [actionError, optimisticEventId, onRemoveOptimisticCall, result, router, validationError]);

  function submit() {
    setFeedback(null);

    const nextActionAtIso = outcome === 'A_RAPPELER' ? toDatetimeIso(nextActionAt) : undefined;

    if (outcome === 'A_RAPPELER' && !nextActionAtIso) {
      setFeedback({ tone: 'error', message: 'Choisissez une date de rappel.' });
      return;
    }

    const eventId = `optimistic-${Date.now()}`;
    setOptimisticEventId(eventId);
    onOptimisticCall({
      id: eventId,
      type: 'call',
      actorUserId: 'agent',
      createdAt: new Date().toISOString(),
      outcome,
      note: note.trim() || null,
      nextActionAt: nextActionAtIso ?? null,
    });

    logCall.execute({
      orderId,
      outcome,
      note: note.trim() || undefined,
      nextActionAt: nextActionAtIso,
    });
  }

  return (
    <section className="sticky bottom-0 -mx-5 space-y-4 border-t border-border bg-surface p-5 md:static md:mx-0 md:rounded-lg md:border">
      <h2 className="text-sm font-semibold uppercase text-muted">Appel</h2>

      <fieldset className="space-y-2">
        <legend className="sr-only">Resultat de l'appel</legend>
        <div className="grid grid-cols-2 gap-2">
          {callOutcomes.map((callOutcome) => (
            <label
              className={`inline-flex min-h-10 cursor-pointer items-center justify-center rounded-lg border px-3 text-center text-sm font-medium ${
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
        <label className="block space-y-2 text-sm font-medium">
          <span>Date de rappel</span>
          <input
            className="h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:border-accent"
            onChange={(event) => setNextActionAt(event.target.value)}
            type="datetime-local"
            value={nextActionAt}
          />
        </label>
      ) : null}

      <label className="block space-y-2 text-sm font-medium">
        <span>Note</span>
        <textarea
          className="min-h-24 w-full resize-none rounded-lg border border-border bg-surface p-3 text-sm outline-none focus:border-accent"
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
          value={note}
        />
        <span className="block text-right text-xs text-muted">{noteLength}/500</span>
      </label>

      <Button className="w-full" disabled={logCall.isExecuting} onClick={submit}>
        {logCall.isExecuting ? 'Enregistrement...' : "Enregistrer l'appel"}
      </Button>

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
