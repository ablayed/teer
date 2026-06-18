'use client';

import { AssignmentDetailsDialog } from '@/components/orders/assignment-details-dialog';
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
import {
  type TransitionAction,
  visibleAllowedActions,
} from '@/lib/domain/order-transition-actions';
import { cn } from '@/lib/utils';
import { ChevronDown, Phone } from 'lucide-react';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

type OrderActionsMenuProps = {
  allowedActions: TransitionAction[];
  // Phase 11.1 : ouvre le popup d'assignation (détails/prix) après « Assigner »
  // et à la réouverture d'une commande assignée. Réservé owner/manager.
  autoOpenAssignment?: boolean;
  canEditAmounts?: boolean;
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
  'demarrer_livraison',
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
  demarrer_livraison: 'Démarrer la livraison',
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
  autoOpenAssignment = false,
  canEditAmounts = false,
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
  // Phase 11.1 : popup d'assignation (détails/prix) ; ouvert après « Assigner »
  // (ref armé au moment de la confirmation du dialog livreur) ou à l'ouverture
  // d'une commande déjà assignée (autoOpenAssignment).
  const [assignmentOpen, setAssignmentOpen] = useState(canEditAmounts && autoOpenAssignment);
  // Phase 13.1 : livreur choisi dans le picker, à assigner SEULEMENT à la confirmation du
  // popup (null à la réouverture d'une commande déjà assignée → popup = demarrer_livraison seul).
  const [pendingDriverId, setPendingDriverId] = useState<string | null>(null);
  const onTransitionSuccessRef = useRef(onTransitionSuccess);

  // Phase 11 : « programmer » supplante « confirmer » dans le dropdown.
  const visibleActions = visibleAllowedActions(allowedActions);
  const transitionEntries = transitionMenuOrder
    .filter((action) => visibleActions.includes(action))
    // Phase 13.1 (point 3) — nettoyage dropdown, UI SEULEMENT (les actions restent
    // au moteur) : « Programmée » (scheduled) → retirer Déconfirmer + Refuser.
    // NB : « En cours de livraison » (out_for_delivery) → Refuser conservé pour
    // l'instant (= marquage d'une livraison échouée ; retrait à confirmer).
    .filter((action) => {
      if (deliveryState === 'scheduled' && (action === 'deconfirmer' || action === 'refuser')) {
        return false;
      }
      return true;
    });
  const canLogCall = visibleActions.includes('journaliser_appel');
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

    // Phase 13.1 : « Assigner » (owner/manager) ne transitionne PLUS au choix du livreur.
    // On capture le livreur choisi et on ouvre le popup ; c'est le popup (« Envoyer au
    // livreur (WhatsApp) ») qui exécute assigner + demarrer_livraison. Annuler le popup
    // laisse la commande « Programmée » (scheduled), sans livreur ni dispatch.
    if (pendingAction === 'assigner' && canEditAmounts) {
      setPendingDriverId(payload.assignedDriverId ?? null);
      setPendingAction(null);
      setAssignmentOpen(true);
      return;
    }

    transition.execute({ orderId, action: pendingAction, payload });
    setPendingAction(null);
  }

  function handleAssignmentConfirmed(result: Extract<TransitionResult, { ok: true }>) {
    setAssignmentOpen(false);
    setPendingDriverId(null);
    if (onTransitionSuccessRef.current) {
      onTransitionSuccessRef.current(result);
    } else {
      router.refresh();
    }
  }

  // Annuler/fermer le popup : aucune transition n'a eu lieu (le picker n'assigne plus) →
  // la commande reste « Programmée », sans livreur. On oublie juste le livreur en attente.
  function handleAssignmentClose() {
    setAssignmentOpen(false);
    setPendingDriverId(null);
  }

  if (!hasMenu && !canCall && !whatsappUrl && !assignmentOpen) {
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

      {assignmentOpen ? (
        <AssignmentDetailsDialog
          driverIdToAssign={pendingDriverId}
          onClose={handleAssignmentClose}
          onConfirmed={handleAssignmentConfirmed}
          orderId={orderId}
        />
      ) : null}
    </div>
  );
}
