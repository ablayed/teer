'use client';

import { AssignmentDetailsDialog } from '@/components/orders/assignment-details-dialog';
import {
  type DriverOption,
  type PayloadDialogAction,
  TransitionDialog,
  type TransitionPayload,
} from '@/components/orders/transition-dialog';
import { ActionSheet, type ActionSheetItem } from '@/components/ui/action-sheet';
import { Button } from '@/components/ui/button';
import { WhatsappComposeSheet } from '@/components/whatsapp/whatsapp-compose-sheet';
import { type TransitionResult, performTransition } from '@/lib/actions/transitions';
import {
  type TransitionAction,
  visibleAllowedActions,
} from '@/lib/domain/order-transition-actions';
import type { WhatsappOrderData } from '@/lib/whatsapp/format';
import { ChevronDown, Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

type OrderActionsMenuProps = {
  allowedActions: TransitionAction[];
  autoOpenAssignment?: boolean;
  canEditAmounts?: boolean;
  deliveryState: string | null;
  drivers: DriverOption[];
  onTransitionSuccess?: (result: Extract<TransitionResult, { ok: true }>) => void;
  orderId: string;
  phone: string | null;
  whatsappOrderData: WhatsappOrderData;
};

// Actions de transition qui ouvrent un dialog (saisie) avant de s'exécuter.
function isPayloadDialogAction(action: TransitionAction): action is PayloadDialogAction {
  return action === 'assigner' || action === 'programmer' || action === 'annuler';
}

// Ordre d'affichage du menu.
const transitionMenuOrder: TransitionAction[] = [
  'programmer',
  'annuler',
  'refuser',
  'journaliser_appel',
  'confirmer',
  'deconfirmer',
  'assigner',
  'demarrer_livraison',
  'livrer',
  'mark_returned',
  'desannuler',
];

const destructiveActions = new Set<TransitionAction>(['annuler', 'mark_returned', 'refuser']);

export function OrderActionsMenu({
  allowedActions,
  autoOpenAssignment = false,
  canEditAmounts = false,
  deliveryState,
  drivers,
  onTransitionSuccess,
  orderId,
  phone,
  whatsappOrderData,
}: OrderActionsMenuProps) {
  const router = useRouter();
  const t = useTranslations('orders');
  const transition = useAction(performTransition);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PayloadDialogAction | null>(null);
  const [assignmentOpen, setAssignmentOpen] = useState(canEditAmounts && autoOpenAssignment);
  const [pendingDriverId, setPendingDriverId] = useState<string | null>(null);
  const onTransitionSuccessRef = useRef(onTransitionSuccess);

  const visibleActions = visibleAllowedActions(allowedActions);
  const isCallQueue = visibleActions.includes('journaliser_appel');
  const transitionEntries = transitionMenuOrder
    .filter((action) => visibleActions.includes(action))
    .filter((action) => {
      if (deliveryState === 'scheduled' && (action === 'deconfirmer' || action === 'refuser')) {
        return false;
      }
      return true;
    });
  const hasMenu = transitionEntries.length > 0;
  const canCall = phone !== null;

  useEffect(() => {
    onTransitionSuccessRef.current = onTransitionSuccess;
  }, [onTransitionSuccess]);

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

  function handleAssignmentClose() {
    setAssignmentOpen(false);
    setPendingDriverId(null);
  }

  function getTransitionLabel(action: TransitionAction): string {
    if (action === 'journaliser_appel') {
      return 'À rappeler';
    }

    if (action === 'refuser' && isCallQueue) {
      return 'Refuser par le client';
    }

    switch (action) {
      case 'confirmer':
        return 'Confirmer';
      case 'programmer':
        return 'Programmer la livraison';
      case 'assigner':
        return 'Assigner';
      case 'demarrer_livraison':
        return 'Démarrer la livraison';
      case 'livrer':
        return 'Marquer livree';
      case 'mark_returned':
        return 'Marquer retournée';
      case 'refuser':
        return 'Refuser';
      case 'annuler':
        return 'Annuler la commande';
      case 'deconfirmer':
        return 'Déconfirmer';
      case 'desannuler':
        return 'Désannuler';
    }
  }

  if (!hasMenu && !canCall && !assignmentOpen) {
    return null;
  }

  const actionItems: ActionSheetItem[] = transitionEntries.map((action) => ({
    key: action,
    label: getTransitionLabel(action),
    onSelect: () => handleTransition(action),
    variant: destructiveActions.has(action) ? 'destructive' : 'default',
    disabled: transition.isExecuting,
  }));

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

        <WhatsappComposeSheet
          order={whatsappOrderData}
          template="clientConfirmation"
          trigger={
            <button
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-text hover:bg-canvas"
              type="button"
            >
              Message client
            </button>
          }
        />

        {hasMenu ? (
          <ActionSheet
            align="end"
            items={actionItems}
            title={t('actions.menuTitle')}
            trigger={
              <Button
                className="min-h-11"
                disabled={transition.isExecuting}
                size="sm"
                type="button"
                variant="primary"
              >
                Actions
                <ChevronDown aria-hidden="true" className="ml-1 size-4" />
              </Button>
            }
          />
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
