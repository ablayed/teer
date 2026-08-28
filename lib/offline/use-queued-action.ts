'use client';

import {
  enqueueMutation,
  flushMutationQueue,
  onMutationSettled,
} from '@/lib/offline/mutation-queue';
import { useCallback, useRef, useState } from 'react';

export type QueuedActionState = 'idle' | 'saving' | 'queued' | 'synced' | 'error';

export function useQueuedAction<TInput>(
  kind: string,
  executor: (input: TInput) => Promise<{ ok: boolean; message?: string }>,
) {
  const [state, setState] = useState<QueuedActionState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const executorRef = useRef(executor);
  executorRef.current = executor;

  const submit = useCallback(
    async (input: TInput, idempotencyKey?: string) => {
      setState('saving');
      setErrorMessage(null);

      const record = await enqueueMutation(kind, input, idempotencyKey);

      const unsubscribe = onMutationSettled(record.id, () => setState('synced'));

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setState('queued');
        return;
      }

      await flushMutationQueue({
        [kind]: async (queuedInput: unknown) => {
          try {
            const result = await executorRef.current(queuedInput as TInput);
            if (!result.ok && result.message) setErrorMessage(result.message);
            return { ok: result.ok };
          } catch {
            return { ok: false };
          }
        },
      });

      // Si toujours en file après une tentative immédiate (échec réseau furtif),
      // l'état visible passe à "en attente" — le prochain 'online' la reprendra.
      setState((current) => (current === 'saving' ? 'queued' : current));
      unsubscribe();
    },
    [kind],
  );

  return { state, errorMessage, submit };
}
