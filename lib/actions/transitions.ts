'use server';

import { requireRole } from '@/lib/actions/safe-action';
import {
  IllegalTransitionError,
  type OrderStatus,
  canTransition,
  orderStatuses,
} from '@/lib/domain/order-state-machine';
import {
  type PaymentChannelAtDelivery,
  type TransitionAction,
  actionToTarget,
  canRolePerformAction,
  getAllowedTransitionActions,
  paymentChannelsAtDelivery,
  transitionActions,
} from '@/lib/domain/order-transition-actions';
import { env } from '@/lib/env';
import type { Database, Tables } from '@/lib/supabase/database.types';
import type { TeamRole } from '@/lib/team/permissions';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

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

const transitionInputSchema = z.object({
  action: z.enum(transitionActions),
  orderId: z.string().uuid(),
  payload: z
    .object({
      note: z.string().trim().max(500).optional(),
      paymentChannelAtDelivery: z.enum(paymentChannelsAtDelivery).optional(),
    })
    .optional(),
});

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
      p_note?: string;
      p_order_id: string;
      p_payment_channel?: PaymentChannelAtDelivery;
      p_to: string;
    },
  ) => ReturnType<SupabaseServerClient['rpc']>;
}

async function writeTransitionAudit({
  action,
  actorUserId,
  from,
  merchantAccountId,
  note,
  orderId,
  paymentChannelAtDelivery,
  to,
}: {
  action: TransitionAction;
  actorUserId: string;
  from: OrderStatus;
  merchantAccountId: string;
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
    resource_type: 'orders',
    resource_id: orderId,
    payload: {
      action,
      source: 'UI',
      prior_state: from,
      next_state: to,
      reason: note,
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
    note?: string;
    paymentChannelAtDelivery?: PaymentChannelAtDelivery;
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

  if (!isOrderStatus(order.cod_status)) {
    return transitionError('invalid_current_status', 'Le statut COD actuel est invalide.');
  }

  const to = actionToTarget(action);

  if (!canTransition(order.cod_status, to)) {
    return transitionError(
      'illegal_transition',
      new IllegalTransitionError(order.cod_status, to).message,
    );
  }

  const note = payload?.note?.trim() || undefined;
  const paymentChannelAtDelivery =
    to === 'LIVREE' ? (payload?.paymentChannelAtDelivery ?? 'ESPECES') : undefined;
  const rpcPaymentChannel = paymentChannelAtDelivery ?? 'ESPECES';
  const { data: nextStatus, error: transitionErrorResult } = await transitionRpc(supabase)(
    'transition_order',
    {
      p_order_id: order.id,
      p_to: to,
      p_actor: actorUserId,
      ...(note ? { p_note: note } : {}),
      p_payment_channel: rpcPaymentChannel,
    },
  );

  if (transitionErrorResult || nextStatus !== to) {
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

  const auditError = await writeTransitionAudit({
    action,
    actorUserId,
    from: order.cod_status,
    merchantAccountId: order.merchant_account_id,
    note: note ?? null,
    orderId: order.id,
    paymentChannelAtDelivery: paymentChannelAtDelivery ?? null,
    to,
  });

  if (auditError) {
    return transitionError('audit_failed', "La transition est appliquee, mais l'audit a echoue.");
  }

  revalidateOrderPaths(order.id);

  return {
    ok: true,
    order: updatedOrder,
    allowedActions: getAllowedTransitionActions(updatedOrder.cod_status, role),
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
