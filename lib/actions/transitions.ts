'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { transitionInputSchema } from '@/lib/actions/transition-input-schema';
import {
  IllegalTransitionError,
  type OrderStatus,
  orderStatuses,
} from '@/lib/domain/order-state-machine';
import {
  type PaymentChannelAtDelivery,
  type TransitionAction,
  actionToTarget,
  buildTransitionDimensionPatch,
  canRolePerformAction,
  getAllowedTransitionActionsForDimensions,
  resolveOrderDimensions,
} from '@/lib/domain/order-transition-actions';
import { env } from '@/lib/env';
import type { Database, Tables } from '@/lib/supabase/database.types';
import type { TeamRole } from '@/lib/team/permissions';
import {
  type PostgrestSingleResponse,
  type SupabaseClient,
  createClient,
} from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';

type SupabaseServerClient = SupabaseClient<Database>;
type OrderRow = Tables<'orders'>;

export type TransitionErrorCode =
  | 'audit_failed'
  | 'forbidden'
  | 'invalid_current_status'
  // 0114 — violations des bornes des deux dates éditables, levées par transition_order.
  | 'invalid_confirmation_after_delivery'
  | 'invalid_date_before_creation'
  | 'invalid_date_future'
  | 'illegal_transition'
  // 0116 — invalidation refusée parce que le cash a déjà été remis par le livreur.
  | 'invalid_invalidate_cash_settled'
  | 'missing_driver_for_dispatch'
  | 'order_not_found'
  | 'update_failed';

// 0116 — un seul message, partagé par la garde TS (pré-mutation, pour un retour immédiat)
// et par le mapping de l'exception SQL (filet incontournable). Les deux doivent dire
// exactement la même chose à l'utilisateur.
const INVALIDATE_CASH_SETTLED_MESSAGE =
  'Le versement de cette commande a déjà été enregistré. Corrigez le versement du livreur avant de pouvoir invalider la livraison.';

// 0114 — transition_order lève une exception nommée par borne violée. Sans ce mapping,
// une date hors bornes tomberait dans le `update_failed` générique, dont le message
// (« Vérifiez vos droits puis réessayez ») serait factuellement faux : les droits sont
// bons, c'est la date qui ne l'est pas. L'ordre de test n'importe pas — la RPC ne lève
// qu'une seule de ces exceptions par appel.
const dateBoundErrorMessages: Record<
  | 'invalid_confirmation_after_delivery'
  | 'invalid_date_before_creation'
  | 'invalid_date_future'
  | 'invalid_invalidate_cash_settled',
  string
> = {
  invalid_confirmation_after_delivery:
    'La date de confirmation ne peut pas être postérieure à la date de livraison.',
  invalid_date_before_creation:
    'Cette date ne peut pas être antérieure à la création de la commande.',
  invalid_date_future: 'Cette date ne peut pas être dans le futur.',
  // 0116 — même mécanisme de mapping : sans lui, cette garde tomberait dans le
  // `update_failed` générique (« Vérifiez vos droits »), message factuellement faux.
  invalid_invalidate_cash_settled: INVALIDATE_CASH_SETTLED_MESSAGE,
};

function dateBoundErrorFrom(message: string | undefined): TransitionResult | null {
  if (!message) {
    return null;
  }

  for (const [code, userMessage] of Object.entries(dateBoundErrorMessages)) {
    if (message.includes(code)) {
      return transitionError(code as TransitionErrorCode, userMessage);
    }
  }

  return null;
}

export type TransitionResult =
  | {
      ok: true;
      order: OrderRow;
      allowedActions: TransitionAction[];
    }
  | {
      ok: false;
      errorCode: TransitionErrorCode;
      message: string;
    };

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function isOrderStatus(value: string): value is OrderStatus {
  return orderStatuses.includes(value as OrderStatus);
}

function transitionError(errorCode: TransitionErrorCode, message: string): TransitionResult {
  return { ok: false, errorCode, message };
}

function revalidateOrderPaths(orderId: string) {
  revalidatePath('/commandes');
  revalidatePath(`/commandes/${orderId}`);
}

function revalidateAffectedAggregatePaths({
  orderId,
  previousOrder,
  updatedOrder,
}: {
  orderId: string;
  previousOrder: Pick<
    OrderRow,
    'assigned_driver_id' | 'cash_state' | 'cod_status' | 'delivery_state' | 'order_state'
  >;
  updatedOrder: Pick<
    OrderRow,
    'assigned_driver_id' | 'cash_state' | 'cod_status' | 'delivery_state' | 'order_state'
  >;
}) {
  revalidateOrderPaths(orderId);

  // Tableau agrège toujours les statuts/activité des commandes → toute transition
  // d'état peut impacter les KPI, la répartition COD et l'activité récente.
  revalidatePath('/tableau');

  const driverTouched =
    previousOrder.assigned_driver_id !== null || updatedOrder.assigned_driver_id !== null;
  if (driverTouched) {
    // Livreurs dépend de l'affectation, des statuts visibles par livreur, du cash
    // en main et des performances des commandes rattachées au livreur.
    revalidatePath('/livreurs');
  }

  const financeTouched =
    driverTouched ||
    previousOrder.cash_state !== updatedOrder.cash_state ||
    previousOrder.delivery_state !== updatedOrder.delivery_state ||
    previousOrder.order_state !== updatedOrder.order_state ||
    previousOrder.cod_status !== updatedOrder.cod_status;
  if (financeTouched) {
    // Finances agrège le cash, les livraisons, les retours et les commandes
    // rattachées à un livreur ; on n'invalide que si une dimension lue par ces
    // vues change réellement.
    revalidatePath('/finances');
  }
}

function transitionRpc(supabase: SupabaseServerClient) {
  return supabase.rpc.bind(supabase) as unknown as (
    fn: 'transition_order',
    args: {
      p_actor: string;
      p_assigned_driver_id?: string;
      p_call_confirmed_at?: string;
      p_call_state?: string;
      p_cancel_reason?: string;
      p_delivered_at?: string;
      p_cash_state?: string;
      p_delivery_state?: string;
      p_next_contact_at?: string;
      p_note?: string;
      p_order_state?: string;
      p_order_id: string;
      p_payment_channel?: PaymentChannelAtDelivery;
      p_scheduled_for?: string;
      p_attempt_count?: number;
      p_cancel_reasons?: string[];
      p_clear_scheduled_for?: boolean;
      p_clear_cancel_reasons?: boolean;
      p_clear_assigned_driver?: boolean;
      p_invalidate_delivered?: boolean;
    },
  ) => Promise<PostgrestSingleResponse<string>>;
}

async function writeTransitionAudit({
  action,
  actorUserId,
  from,
  fromDimensions,
  merchantAccountId,
  nextDimensions,
  note,
  orderId,
  paymentChannelAtDelivery,
  to,
}: {
  action: TransitionAction;
  actorUserId: string;
  from: OrderStatus;
  fromDimensions: Pick<
    OrderRow,
    | 'assigned_driver_id'
    | 'attempt_count'
    | 'call_state'
    | 'cancel_reason'
    | 'cancel_reasons'
    | 'cash_state'
    | 'delivery_state'
    | 'next_contact_at'
    | 'order_state'
    | 'scheduled_for'
  >;
  merchantAccountId: string;
  nextDimensions: Pick<
    OrderRow,
    | 'assigned_driver_id'
    | 'attempt_count'
    | 'call_state'
    | 'cancel_reason'
    | 'cancel_reasons'
    | 'cash_state'
    | 'delivery_state'
    | 'next_contact_at'
    | 'order_state'
    | 'scheduled_for'
  >;
  note: string | null;
  orderId: string;
  paymentChannelAtDelivery: PaymentChannelAtDelivery | null;
  to: OrderStatus;
}) {
  const admin = createSupabaseAdminClient();

  const { error } = await admin.from('audit_log').insert({
    merchant_account_id: merchantAccountId,
    actor_user_id: actorUserId,
    action: 'order.transition',
    prior_state: from,
    next_state: to,
    resource_type: 'orders',
    resource_id: orderId,
    source: 'UI',
    reason: note,
    payload: {
      action,
      source: 'UI',
      priorDimensions: fromDimensions,
      nextDimensions,
      paymentChannelAtDelivery,
      occurredAt: new Date().toISOString(),
    },
  });

  return error;
}

export async function performTransitionForContext({
  action,
  actorUserId,
  orderId,
  payload,
  role,
  supabase,
}: {
  action: TransitionAction;
  actorUserId: string;
  orderId: string;
  payload?: {
    assignedDriverId?: string;
    cancelReason?: string;
    cancelReasons?: string[];
    callConfirmedAt?: string;
    deliveredAt?: string;
    nextContactAt?: string;
    note?: string;
    paymentChannelAtDelivery?: PaymentChannelAtDelivery;
    scheduledFor?: string;
  };
  role: TeamRole;
  supabase: SupabaseServerClient;
}): Promise<TransitionResult> {
  if (!canRolePerformAction(role, action)) {
    return transitionError('forbidden', "Vous n'avez pas le droit d'executer cette action.");
  }

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .maybeSingle();

  if (orderError) {
    return transitionError('update_failed', "La commande n'a pas pu être chargée.");
  }

  if (!order) {
    return transitionError('order_not_found', 'Commande introuvable.');
  }

  const currentDimensions = resolveOrderDimensions(order);
  const currentStatus = isOrderStatus(order.cod_status)
    ? order.cod_status
    : currentDimensions.codStatus;

  if (!isOrderStatus(currentStatus)) {
    return transitionError('invalid_current_status', 'Le statut COD actuel est invalide.');
  }

  if (!getAllowedTransitionActionsForDimensions(currentDimensions, role).includes(action)) {
    return transitionError(
      'illegal_transition',
      new IllegalTransitionError(currentStatus, actionToTarget(action)).message,
    );
  }

  const note = payload?.note?.trim() || undefined;
  const transitionPatch = buildTransitionDimensionPatch(action, currentDimensions, {
    assignedDriverId: payload?.assignedDriverId,
    cancelReason: payload?.cancelReason,
    cancelReasons: payload?.cancelReasons,
    nextContactAt: payload?.nextContactAt,
    paymentChannelAtDelivery: payload?.paymentChannelAtDelivery,
    callConfirmedAt: payload?.callConfirmedAt,
    deliveredAt: payload?.deliveredAt,
    scheduledFor: payload?.scheduledFor,
  });
  const paymentChannelAtDelivery = transitionPatch.paymentChannelAtDelivery;

  // Invariante dispatch ⇒ livreur (bug #6) : refuser AVANT toute mutation de passer
  // delivery_state à assigned/out_for_delivery sans livreur effectif (ni dans le payload,
  // ni déjà sur la commande). Ferme centralement les chemins inline qui appellent
  // `assigner` sans driver (cod-status-selector, transitionOrderStatusAction, Kanban
  // mobile). Défense en profondeur : la contrainte CHECK orders_dispatch_requires_driver
  // (migration 0057) est le filet base ; cette garde donne le bon message utilisateur.
  const effectiveDriverId = transitionPatch.assignedDriverId ?? currentDimensions.assignedDriverId;
  if (
    (transitionPatch.deliveryState === 'assigned' ||
      transitionPatch.deliveryState === 'out_for_delivery') &&
    !effectiveDriverId
  ) {
    return transitionError(
      'missing_driver_for_dispatch',
      'Assignez un livreur avant de passer la commande en livraison.',
    );
  }

  // 0116 — garde cash de l'invalidation, en défense en profondeur. transition_order la
  // repose côté SQL (elle est donc incontournable, y compris par appel RPC direct) ; ici
  // elle évite un aller-retour et rend le message sans dépendre du parsing d'exception.
  // « remitted »/« discrepancy » : un cash_settlement existe déjà, or cette action ne sait
  // pas le contre-passer et n'écrit aucun audit — cf. commentaire de tête de 0116.
  if (
    transitionPatch.invalidateDelivered &&
    (order.cash_state === 'remitted' || order.cash_state === 'discrepancy')
  ) {
    return transitionError('invalid_invalidate_cash_settled', INVALIDATE_CASH_SETTLED_MESSAGE);
  }

  const { data: nextStatus, error: transitionErrorResult } = await transitionRpc(supabase)(
    'transition_order',
    {
      p_order_id: order.id,
      p_actor: actorUserId,
      ...(transitionPatch.assignedDriverId
        ? { p_assigned_driver_id: transitionPatch.assignedDriverId }
        : {}),
      ...(transitionPatch.callConfirmedAt
        ? { p_call_confirmed_at: transitionPatch.callConfirmedAt }
        : {}),
      ...(transitionPatch.deliveredAt ? { p_delivered_at: transitionPatch.deliveredAt } : {}),
      ...(transitionPatch.attemptCount !== undefined
        ? { p_attempt_count: transitionPatch.attemptCount }
        : {}),
      ...(transitionPatch.callState ? { p_call_state: transitionPatch.callState } : {}),
      ...(transitionPatch.cancelReason ? { p_cancel_reason: transitionPatch.cancelReason } : {}),
      ...(transitionPatch.cancelReasons ? { p_cancel_reasons: transitionPatch.cancelReasons } : {}),
      ...(transitionPatch.cashState ? { p_cash_state: transitionPatch.cashState } : {}),
      ...(transitionPatch.deliveryState ? { p_delivery_state: transitionPatch.deliveryState } : {}),
      ...(transitionPatch.clearScheduledFor ? { p_clear_scheduled_for: true } : {}),
      ...(transitionPatch.clearCancelReasons ? { p_clear_cancel_reasons: true } : {}),
      ...(transitionPatch.clearAssignedDriver ? { p_clear_assigned_driver: true } : {}),
      ...(transitionPatch.invalidateDelivered ? { p_invalidate_delivered: true } : {}),
      ...(transitionPatch.nextContactAt
        ? { p_next_contact_at: transitionPatch.nextContactAt }
        : {}),
      ...(note ? { p_note: note } : {}),
      ...(transitionPatch.orderState ? { p_order_state: transitionPatch.orderState } : {}),
      ...(paymentChannelAtDelivery ? { p_payment_channel: paymentChannelAtDelivery } : {}),
      ...(transitionPatch.scheduledFor ? { p_scheduled_for: transitionPatch.scheduledFor } : {}),
    },
  );

  if (transitionErrorResult || !isOrderStatus(nextStatus)) {
    const dateBoundError = dateBoundErrorFrom(transitionErrorResult?.message);
    if (dateBoundError) {
      return dateBoundError;
    }

    return transitionError(
      'update_failed',
      "La transition n'a pas pu être appliquée. Vérifiez vos droits puis réessayez.",
    );
  }

  const { data: updatedOrder, error: updatedOrderError } = await supabase
    .from('orders')
    .select('*')
    .eq('id', order.id)
    .maybeSingle();

  if (updatedOrderError || !updatedOrder) {
    return transitionError('update_failed', "La commande mise à jour n'a pas pu être rechargée.");
  }

  if (!isOrderStatus(updatedOrder.cod_status)) {
    return transitionError('invalid_current_status', 'Le nouveau statut COD est invalide.');
  }

  const updatedDimensions = resolveOrderDimensions(updatedOrder);

  // ⚠️ EXCEPTION DÉLIBÉRÉE ET UNIQUE À LA CONVENTION DU PROJET (0116, « Invalider »).
  // Toute action sensible pose normalement une ligne `audit_log` ; celle-ci n'en pose
  // AUCUNE — ni visible dans l'UI, ni cachée en base. C'est une décision produit explicite
  // du porteur, assumée en connaissance de cause, pas un oubli et pas une régression.
  // NE PAS « corriger » en rebranchant writeTransitionAudit ici : ce serait réintroduire
  // une trace que le porteur a demandé de ne pas garder. Documenté dans CLAUDE.md.
  // (La ligne `order_state_transition` posée par la RPC reste, elle, indispensable : c'est
  // l'ancre d'idempotence des mouvements de stock, pas une trace d'audit.)
  const auditError =
    action === 'invalider'
      ? null
      : await writeTransitionAudit({
          action,
          actorUserId,
          from: currentStatus,
          fromDimensions: {
            assigned_driver_id: order.assigned_driver_id,
            attempt_count: order.attempt_count,
            call_state: order.call_state,
            cancel_reason: order.cancel_reason,
            cancel_reasons: order.cancel_reasons,
            cash_state: order.cash_state,
            delivery_state: order.delivery_state,
            next_contact_at: order.next_contact_at,
            order_state: order.order_state,
            scheduled_for: order.scheduled_for,
          },
          merchantAccountId: order.merchant_account_id,
          nextDimensions: {
            assigned_driver_id: updatedOrder.assigned_driver_id,
            attempt_count: updatedOrder.attempt_count,
            call_state: updatedOrder.call_state,
            cancel_reason: updatedOrder.cancel_reason,
            cancel_reasons: updatedOrder.cancel_reasons,
            cash_state: updatedOrder.cash_state,
            delivery_state: updatedOrder.delivery_state,
            next_contact_at: updatedOrder.next_contact_at,
            order_state: updatedOrder.order_state,
            scheduled_for: updatedOrder.scheduled_for,
          },
          note: note ?? null,
          orderId: order.id,
          paymentChannelAtDelivery: paymentChannelAtDelivery ?? null,
          to: updatedOrder.cod_status,
        });

  if (auditError) {
    return transitionError('audit_failed', "La transition est appliquee, mais l'audit a echoue.");
  }

  // Stock movements are now posted atomically inside transition_order (SQL).
  // Nothing to do here — the RPC already committed them in the same transaction.

  revalidateAffectedAggregatePaths({
    orderId: order.id,
    previousOrder: {
      assigned_driver_id: order.assigned_driver_id,
      cash_state: order.cash_state,
      cod_status: order.cod_status,
      delivery_state: order.delivery_state,
      order_state: order.order_state,
    },
    updatedOrder: {
      assigned_driver_id: updatedOrder.assigned_driver_id,
      cash_state: updatedOrder.cash_state,
      cod_status: updatedOrder.cod_status,
      delivery_state: updatedOrder.delivery_state,
      order_state: updatedOrder.order_state,
    },
  });

  return {
    ok: true,
    order: updatedOrder,
    allowedActions: getAllowedTransitionActionsForDimensions(updatedDimensions, role),
  };
}

export const performTransition = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'orders.perform_transition', section: 'orders' })
  .inputSchema(transitionInputSchema)
  .action(async ({ ctx, parsedInput }) =>
    performTransitionForContext({
      action: parsedInput.action,
      actorUserId: ctx.user.id,
      orderId: parsedInput.orderId,
      payload: parsedInput.payload,
      role: ctx.member.role,
      supabase: ctx.supabase as unknown as SupabaseServerClient,
    }),
  );
