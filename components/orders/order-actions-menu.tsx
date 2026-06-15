'use client';

import { CallLogDialog } from '@/components/orders/call-log-dialog';
import {
  type DriverOption,
  type PayloadDialogAction,
  TransitionDialog,
  type TransitionPayload,
} from '@/components/orders/transition-dialog';
import { WhatsAppConfirmButton } from '@/components/orders/whatsapp-confirm-button';
import { Button } from '@/components/ui/button';
import { type TransitionResult, performTransition } from '@/lib/actions/transitions';
import type { TransitionAction } from '@/lib/domain/order-transition-actions';
import { cn } from '@/lib/utils';
import { ChevronDown, Phone } from 'lucide-react';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

type OrderActionsMenuProps = {
  allowedActions: TransitionAction[];
  deliveryState: string | null;
  dispatchWhatsAppUrl: string | null;
  drivers: DriverOption[];
  onTransitionSuccess?: (result: Extract<TransitionResult, { ok: true }>) => void;
  orderId: string;
  phone: string | null;
  whatsappLabels: { confirm: string; missingPhone: string };
  whatsappUrl: string | null;
};

// Actions de transition qui ouvrent un dialog (saisie) avant de s'executer.
function isPayloadDialogAction(action: TransitionAction): action is PayloadDialogAction {
  return action === 'assigner' || action === 'programmer' || action === 'annuler';
}

// Libelles unifies (memes que l'ancien detail) — l'ordre d'affichage du menu.
const transitionMenuOrder: TransitionAction[] = [
  'confirmer',
  'deconfirmer',
  'programmer',
  'assigner',
  'livrer',
  'mark_returned',
  'refuser',
  'annuler',
  'desannuler',
];

const transitionLabels: Record<TransitionAction, string> = {
  journaliser_appel: 'Journaliser un appel',
  confirmer: 'Confirmer',
  programmer: 'Programmer la livraison',
  assigner: 'Assigner',
  livrer: 'Marquer livree',
  mark_returned: 'Marquer retournée',
  refuser: 'Refuser',
  annuler: 'Annuler la commande',
  deconfirmer: 'Déconfirmer',
  desannuler: 'Désannuler',
};

const destructiveActions = new Set<TransitionAction>(['annuler', 'mark_returned', 'refuser']);

export function OrderActionsMenu({
  allowedActions,
  deliveryState,
  dispatchWhatsAppUrl,
  drivers,
  onTransitionSuccess,
  orderId,
  phone,
  whatsappLabels,
  whatsappUrl,
}: OrderActionsMenuProps) {
  const router = useRouter();
  const transition = useAction(performTransition);
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<'down' | 'up'>('down');
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PayloadDialogAction | null>(null);
  const [callDialogOpen, setCallDialogOpen] = useState(false);
  const onTransitionSuccessRef = useRef(onTransitionSuccess);

  const transitionEntries = transitionMenuOrder.filter((action) => allowedActions.includes(action));
  const canLogCall = allowedActions.includes('journaliser_appel');
  const canDispatch =
    Boolean(dispatchWhatsAppUrl) &&
    (deliveryState === 'assigned' || deliveryState === 'out_for_delivery');
  const hasMenu = transitionEntries.length > 0 || canLogCall || canDispatch;
  const canCall = phone !== null;

  useEffect(() => {
    onTransitionSuccessRef.current = onTransitionSuccess;
  }, [onTransitionSuccess]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Place le menu pour qu'il reste atteignable en portrait : il bascule vers le
  // haut quand l'espace sous la carte (jusqu'a la barre de nav fixe du bas) est
  // insuffisant, et plafonne sa hauteur avec un scroll interne (ceinture +
  // bretelles). Le conteneur `relative` enveloppe le seul bouton (le menu est
  // `absolute`, hors flux) → son rect = celui du declencheur.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    function reposition() {
      const trigger = containerRef.current;
      if (!trigger) {
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const gap = 8;
      // Reserve la hauteur de la barre de nav fixe (mobile uniquement, ~64px
      // + safe-area) pour ne jamais glisser le menu dessous.
      const bottomInset = window.innerWidth < 768 ? 96 : 8;
      const spaceBelow = window.innerHeight - bottomInset - rect.bottom - gap;
      const spaceAbove = rect.top - gap;
      const next: 'down' | 'up' = spaceBelow < 240 && spaceAbove > spaceBelow ? 'up' : 'down';
      setPlacement(next);
      setMaxHeight(Math.max(160, Math.floor(next === 'up' ? spaceAbove : spaceBelow)));
    }

    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  useEffect(() => {
    const result = transition.result.data;

    if (!result) {
      return;
    }

    if (result.ok) {
      setFeedback('Commande mise à jour.');
      if (onTransitionSuccessRef.current) {
        onTransitionSuccessRef.current(result);
      } else {
        router.refresh();
      }
      return;
    }

    setFeedback(result.message);
  }, [router, transition.result.data]);

  function handleTransition(action: TransitionAction) {
    setFeedback(null);
    setOpen(false);

    if (isPayloadDialogAction(action)) {
      setPendingAction(action);
      return;
    }

    transition.execute({ orderId, action });
  }

  function handleDialogConfirm(payload: TransitionPayload) {
    if (!pendingAction) {
      return;
    }

    transition.execute({ orderId, action: pendingAction, payload });
    setPendingAction(null);
  }

  if (!hasMenu && !canCall && !whatsappUrl) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {canCall ? (
          <a
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-text hover:bg-canvas"
            href={`tel:${phone?.replace(/\s/g, '') ?? ''}`}
          >
            <Phone aria-hidden="true" className="size-4" />
            Appeler
          </a>
        ) : null}

        {canCall || whatsappUrl ? (
          <WhatsAppConfirmButton
            disabledLabel={whatsappLabels.missingPhone}
            label={whatsappLabels.confirm}
            url={whatsappUrl}
          />
        ) : null}

        {hasMenu ? (
          <div className="relative" ref={containerRef}>
            <Button
              aria-expanded={open}
              aria-haspopup="menu"
              className="min-h-11"
              disabled={transition.isExecuting}
              onClick={() => setOpen((value) => !value)}
              size="sm"
              type="button"
              variant="primary"
            >
              Actions
              <ChevronDown aria-hidden="true" className="ml-1 size-4" />
            </Button>

            {open ? (
              <div
                className={cn(
                  'absolute right-0 z-50 w-60 overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface py-1 shadow-2',
                  placement === 'up' ? 'bottom-full mb-2' : 'top-full mt-2',
                )}
                role="menu"
                style={maxHeight ? { maxHeight } : undefined}
              >
                {transitionEntries.map((action) => (
                  <button
                    className={cn(
                      'flex min-h-11 w-full items-center px-4 text-left text-sm font-medium hover:bg-canvas',
                      destructiveActions.has(action) ? 'text-danger' : 'text-text',
                    )}
                    disabled={transition.isExecuting}
                    key={action}
                    onClick={() => handleTransition(action)}
                    role="menuitem"
                    type="button"
                  >
                    {transitionLabels[action]}
                  </button>
                ))}

                {canLogCall ? (
                  <button
                    className="flex min-h-11 w-full items-center px-4 text-left text-sm font-medium text-text hover:bg-canvas"
                    onClick={() => {
                      setOpen(false);
                      setCallDialogOpen(true);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    {transitionLabels.journaliser_appel}
                  </button>
                ) : null}

                {canDispatch && dispatchWhatsAppUrl ? (
                  <a
                    className="flex min-h-11 w-full items-center px-4 text-left text-sm font-medium text-text hover:bg-canvas"
                    href={dispatchWhatsAppUrl}
                    onClick={() => setOpen(false)}
                    rel="noreferrer"
                    role="menuitem"
                    target="_blank"
                  >
                    Envoyer au livreur (WhatsApp)
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {feedback ? <p className="text-sm text-muted">{feedback}</p> : null}

      {pendingAction ? (
        <TransitionDialog
          action={pendingAction}
          drivers={drivers}
          isSubmitting={transition.isExecuting}
          onCancel={() => setPendingAction(null)}
          onConfirm={handleDialogConfirm}
        />
      ) : null}

      {callDialogOpen ? (
        <CallLogDialog onClose={() => setCallDialogOpen(false)} orderId={orderId} />
      ) : null}
    </div>
  );
}
