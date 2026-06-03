'use client';

import { WhatsAppConfirmButton } from '@/components/orders/whatsapp-confirm-button';
import { Button } from '@/components/ui/button';
import { performTransition } from '@/lib/actions/transitions';
import type { TransitionAction } from '@/lib/domain/order-transition-actions';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

type OrderInlineActionsProps = {
  allowedActions: TransitionAction[];
  orderId: string;
  phone: string | null;
  whatsappMissingPhoneLabel: string;
  whatsappUrl: string | null;
};

const transitionLabels: Partial<Record<TransitionAction, string>> = {
  confirmer: 'Confirmer',
  programmer: 'Programmer',
  assigner: 'Assigner',
  livrer: 'Livr\u00e9',
  annuler: 'Annuler',
  refuser: 'Refuser',
};

const inlineTransitionOrder: TransitionAction[] = [
  'confirmer',
  'programmer',
  'assigner',
  'livrer',
  'annuler',
  'refuser',
];

export function OrderInlineActions({
  allowedActions,
  orderId,
  phone,
  whatsappMissingPhoneLabel,
  whatsappUrl,
}: OrderInlineActionsProps) {
  const router = useRouter();
  const transition = useAction(performTransition);
  const [feedback, setFeedback] = useState<string | null>(null);
  const visibleActions = useMemo(
    () =>
      inlineTransitionOrder.filter(
        (action) => allowedActions.includes(action) && transitionLabels[action],
      ),
    [allowedActions],
  );
  const canContact =
    phone !== null &&
    (allowedActions.includes('journaliser_appel') || allowedActions.includes('confirmer'));

  function handleTransition(action: TransitionAction) {
    setFeedback(null);
    transition.execute({ orderId, action });
  }

  useEffect(() => {
    const result = transition.result.data;

    if (!result) {
      return;
    }

    if (result.ok) {
      setFeedback('Commande mise \u00e0 jour.');
      router.refresh();
      return;
    }

    setFeedback(result.message);
  }, [router, transition.result.data]);

  if (!canContact && visibleActions.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {canContact ? (
          <a
            className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-medium text-text hover:bg-canvas"
            href={`tel:${phone?.replace(/\s/g, '') ?? ''}`}
          >
            Appeler
          </a>
        ) : null}
        {(canContact || whatsappUrl) && (
          <WhatsAppConfirmButton
            disabledLabel={whatsappMissingPhoneLabel}
            label="WhatsApp"
            url={whatsappUrl}
          />
        )}
        {visibleActions.map((action) => (
          <Button
            className="min-h-11"
            disabled={transition.isExecuting}
            key={action}
            onClick={() => handleTransition(action)}
            size="sm"
            type="button"
            variant={action === 'annuler' || action === 'refuser' ? 'ghost' : 'primary'}
          >
            {transitionLabels[action]}
          </Button>
        ))}
      </div>
      {feedback ? <p className="text-sm text-muted">{feedback}</p> : null}
    </div>
  );
}
