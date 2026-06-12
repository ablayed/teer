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
  | 'illegal_transition'
  | 'order_not_found'
  | 'update_failed';

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

function transitionRpc(supabase: SupabaseServerClient) {
  return supabase.rpc.bind(supabase) as unknown as (
    fn: 'transition_order',
    args: {
      p_actor: string;
      p_assigned_driver_id?: string;
      p_call_state?: string;
      p_cancel_reason?: string;
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
    return transitionError('update_failed', "La commande n'a pas pu etre chargee.");
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
    scheduledFor: payload?.scheduledFor,
  });
  const paymentChannelAtDelivery = transitionPatch.paymentChannelAtDelivery;
  const { data: nextStatus, error: transitionErrorResult } = await transitionRpc(supabase)(
    'transition_order',
    {
      p_order_id: order.id,
      p_actor: actorUserId,
      ...(transitionPatch.assignedDriverId
        ? { p_assigned_driver_id: transitionPatch.assignedDriverId }
        : {}),
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
    return transitionError(
      'update_failed',
      "La transition n'a pas pu etre appliquee. Verifiez vos droits puis reessayez.",
    );
  }

  const { data: updatedOrder, error: updatedOrderError } = await supabase
    .from('orders')
    .select('*')
    .eq('id', order.id)
    .maybeSingle();

  if (updatedOrderError || !updatedOrder) {
    return transitionError('update_failed', "La commande mise a jour n'a pas pu etre rechargee.");
  }

  if (!isOrderStatus(updatedOrder.cod_status)) {
    return transitionError('invalid_current_status', 'Le nouveau statut COD est invalide.');
  }

  const updatedDimensions = resolveOrderDimensions(updatedOrder);
  const auditError = await writeTransitionAudit({
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

  revalidateOrderPaths(order.id);

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
