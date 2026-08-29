'use client';

import {
  enqueueMutation,
  flushMutationQueue,
  onMutationSettled,
} from '@/lib/offline/mutation-queue';
import { useCallback, useEffect, useRef, useState } from 'react';

export type QueuedActionState = 'idle' | 'saving' | 'queued' | 'synced' | 'error';

export function useQueuedAction<TInput>(
  kind: string,
  executor: (input: TInput) => Promise<{ ok: boolean; message?: string }>,
) {
  const [state, setState] = useState<QueuedActionState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const executorRef = useRef(executor);
  executorRef.current = executor;
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Libère l'abonnement de règlement en cours si le composant démonte avant
  // que la mutation ne soit réglée — sinon le listener reste enregistré
  // indéfiniment dans mutation-queue.ts.
  useEffect(() => {
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, []);

  const submit = useCallback(
    async (input: TInput, idempotencyKey?: string) => {
      setState('saving');
      setErrorMessage(null);

      // Un appel de submit précédent encore en attente (rare, mais possible
      // si l'appelant relance sans attendre) ne doit pas laisser un abonnement
      // orphelin pointant sur une mutation qu'on ne suit plus.
      unsubscribeRef.current?.();

      const record = await enqueueMutation(kind, input, idempotencyKey);

      // Le désabonnement ne doit avoir lieu QUE quand la mutation est
      // réellement réglée — jamais de façon inconditionnelle après une
      // tentative de flush immédiat, qui peut échouer sans supprimer
      // l'enregistrement d'IndexedDB (mutation-queue.ts ne supprime que sur
      // {ok:true}). Se désabonner trop tôt rend ce hook sourd à un règlement
      // ultérieur déclenché ailleurs (ex. initMutationQueueAutoFlush sur
      // l'évènement 'online'), et le bouton reste bloqué sur "en attente" pour
      // toujours même après une synchronisation réelle.
      const unsubscribe = onMutationSettled(record.id, () => {
        setState('synced');
        unsubscribe();
        unsubscribeRef.current = null;
      });
      unsubscribeRef.current = unsubscribe;

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setState('queued');
        return;
      }

      let attemptFailed = false;
      await flushMutationQueue({
        [kind]: async (queuedInput: unknown) => {
          try {
            const result = await executorRef.current(queuedInput as TInput);
            if (!result.ok) {
              attemptFailed = true;
              if (result.message) setErrorMessage(result.message);
            }
            return { ok: result.ok };
          } catch {
            attemptFailed = true;
            return { ok: false };
          }
        },
      });

      // Si le flush a réussi, `onMutationSettled` a déjà positionné 'synced'
      // de façon synchrone (avant que `flushMutationQueue` ne résolve) — ne
      // pas l'écraser ici. Sinon : un échec pendant qu'on est en ligne est une
      // vraie erreur ('error') ; hors ligne (ou pas encore de verdict), l'état
      // reste 'queued'. Dans les deux cas l'enregistrement reste dans la file
      // durable et l'abonnement reste actif pour un règlement ultérieur.
      setState((current) => {
        if (current !== 'saving') return current;
        return attemptFailed ? 'error' : 'queued';
      });
    },
    [kind],
  );

  return { state, errorMessage, submit };
}
