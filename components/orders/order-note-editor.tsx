'use client';

import { Button } from '@/components/ui/button';
import { setOrderNoteAction } from '@/lib/actions/orders';
import { ORDER_NOTE_MAX_LENGTH, normalizeOrderNote } from '@/lib/orders/order-note';
import { cn } from '@/lib/utils';
import { StickyNote } from 'lucide-react';
import { useAction } from 'next-safe-action/hooks';
import { useId, useState } from 'react';

type OrderNoteEditorProps = {
  initialNote: string | null;
  orderId: string;
};

// Note libre d'équipe (0118). Visible et éditable pour owner/manager/agent, quel
// que soit l'état de la commande — d'où l'absence totale de gating sur un rôle
// ou une dimension ici : la garde vit dans `setOrderNoteAction` + la RPC.
//
// Données serveur post-mutation (Paradigm A) : la valeur affichée après
// enregistrement vient d'un état client local (`savedNote`), JAMAIS d'un
// `router.refresh()` / d'une navigation — un RSC relu via le Router Cache rend
// la valeur périmée ~20 % du temps en build de prod.
export function OrderNoteEditor({ initialNote, orderId }: OrderNoteEditorProps) {
  const fieldId = useId();
  const save = useAction(setOrderNoteAction);
  const [savedNote, setSavedNote] = useState(initialNote ?? '');
  const [draft, setDraft] = useState(initialNote ?? '');
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(
    null,
  );

  const dirty = normalizeOrderNote(draft) !== normalizeOrderNote(savedNote);
  const tooLong = draft.length > ORDER_NOTE_MAX_LENGTH;

  async function handleSave() {
    if (!dirty || tooLong || save.isExecuting) {
      return;
    }

    setFeedback(null);
    const result = await save.executeAsync({ orderId, note: normalizeOrderNote(draft) });

    if (!result?.data?.ok) {
      setFeedback({ tone: 'error', message: "L'enregistrement de la note a échoué." });
      return;
    }

    const stored = result.data.note ?? '';
    setSavedNote(stored);
    setDraft(stored);
    setFeedback({ tone: 'success', message: 'Note enregistrée.' });
  }

  return (
    <section className="space-y-3" data-testid="order-note">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase text-muted">Note</h2>
        <span
          className={cn('font-mono text-xs tabular-nums', tooLong ? 'text-danger' : 'text-muted')}
        >
          {draft.length}/{ORDER_NOTE_MAX_LENGTH}
        </span>
      </div>

      <label className="sr-only" htmlFor={fieldId}>
        Note libre sur la commande
      </label>
      <textarea
        className="min-h-24 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text shadow-1 outline-none transition placeholder:text-muted focus:border-accent"
        id={fieldId}
        onChange={(event) => {
          setDraft(event.target.value);
          setFeedback(null);
        }}
        placeholder="Information utile à l'équipe : client injoignable le matin, immeuble sans ascenseur…"
        value={draft}
      />

      {feedback ? (
        <output
          className={cn(
            'block rounded-lg border p-3 text-sm font-medium',
            feedback.tone === 'success'
              ? 'border-success/30 bg-success-subtle text-success'
              : 'border-danger/30 bg-danger-subtle text-danger',
          )}
        >
          {feedback.message}
        </output>
      ) : null}

      <Button
        className="min-h-12 w-full"
        disabled={!dirty || tooLong || save.isExecuting}
        onClick={handleSave}
        type="button"
      >
        <StickyNote aria-hidden="true" className="mr-2 size-4" />
        {save.isExecuting ? 'Enregistrement…' : 'Enregistrer la note'}
      </Button>
    </section>
  );
}
