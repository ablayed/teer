'use server';

import { getMerchantAccount } from '@/lib/actions/merchant';
import { authActionClient } from '@/lib/actions/safe-action';
import {
  IllegalTransitionError,
  type OrderStatus,
  assertTransition,
  orderStatuses,
} from '@/lib/domain/order-state-machine';
import { env } from '@/lib/env';
import { type CodStatus, codStatuses } from '@/lib/orders/status';
import type { Database, Tables } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

type CustomerSummary = Pick<Tables<'customer'>, 'full_name' | 'phone'>;
type CustomerDetail = Pick<
  Tables<'customer'>,
  'email' | 'full_name' | 'phone' | 'shipping_address'
>;

export type OrderListItem = Pick<
  Tables<'orders'>,
  | 'cod_status'
  | 'created_at_shopify'
  | 'currency'
  | 'customer_id'
  | 'id'
  | 'order_number'
  | 'total_amount'
> & {
  customer: CustomerSummary | null;
};

export type OrderDetail = Tables<'orders'> & {
  customer: CustomerDetail | null;
};

type GetOrdersInput = {
  codStatus?: CodStatus;
};

const callOutcomes = ['CONFIRMEE', 'SANS_REPONSE', 'A_RAPPELER', 'REFUSEE'] as const;

type CallOutcome = (typeof callOutcomes)[number];
type OrderActionErrorCode =
  | 'audit_failed'
  | 'call_log_failed'
  | 'invalid_current_status'
  | 'illegal_transition'
  | 'merchant_not_found'
  | 'order_not_found'
  | 'transition_log_failed'
  | 'update_failed';
type SupabaseServerClient = SupabaseClient<Database>;

export type OrderTransitionTimelineEvent = {
  id: string;
  type: 'transition';
  createdAt: string;
  actorUserId: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  note: string | null;
};

export type OrderCallTimelineEvent = {
  id: string;
  type: 'call';
  createdAt: string;
  actorUserId: string;
  outcome: CallOutcome;
  note: string | null;
  nextActionAt: string | null;
};

export type OrderTimelineEvent = OrderTransitionTimelineEvent | OrderCallTimelineEvent;

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function asTypedSupabaseClient(client: unknown): SupabaseServerClient {
  return client as SupabaseServerClient;
}

function isOrderStatus(value: string): value is OrderStatus {
  return orderStatuses.includes(value as OrderStatus);
}

function isCallOutcome(value: string): value is CallOutcome {
  return callOutcomes.includes(value as CallOutcome);
}

function toOrderStatus(value: string | null): OrderStatus | null {
  return value && isOrderStatus(value) ? value : null;
}

function toCallOutcome(value: string): CallOutcome {
  return isCallOutcome(value) ? value : 'SANS_REPONSE';
}

function transitionErrorPayload(error: IllegalTransitionError): {
  ok: false;
  errorCode: OrderActionErrorCode;
  message: string;
} {
  return {
    ok: false,
    errorCode: 'illegal_transition',
    message: error.message,
  };
}

function revalidateOrderPaths(orderId: string) {
  revalidatePath('/commandes');
  revalidatePath(`/commandes/${orderId}`);
}

async function writeOrderAuditLog({
  action,
  actorUserId,
  merchantAccountId,
  orderId,
  payload,
}: {
  action: 'call.logged' | 'order.transition';
  actorUserId: string;
  merchantAccountId: string;
  orderId: string;
  payload?: Database['public']['Tables']['audit_log']['Insert']['payload'];
}) {
  const admin = createSupabaseAdminClient();

  const { error } = await admin.from('audit_log').insert({
    merchant_account_id: merchantAccountId,
    actor_user_id: actorUserId,
    action,
    resource_type: 'orders',
    resource_id: orderId,
    payload,
  });

  return error;
}

async function applyOrderTransition({
  actorUserId,
  from,
  merchantAccountId,
  note,
  orderId,
  supabase,
  to,
}: {
  actorUserId: string;
  from: OrderStatus;
  merchantAccountId: string;
  note: string | undefined;
  orderId: string;
  supabase: SupabaseServerClient;
  to: OrderStatus;
}): Promise<{ ok: true } | { ok: false; errorCode: 'transition_log_failed' | 'update_failed' }> {
  const now = new Date().toISOString();
  const { data: updatedOrder, error: updateError } = await supabase
    .from('orders')
    .update({
      cod_status: to,
      updated_at: now,
    })
    .eq('id', orderId)
    .eq('merchant_account_id', merchantAccountId)
    .eq('cod_status', from)
    .select('id')
    .maybeSingle();

  if (updateError || !updatedOrder) {
    return { ok: false, errorCode: 'update_failed' };
  }

  const { error: transitionError } = await supabase.from('order_state_transition').insert({
    merchant_account_id: merchantAccountId,
    order_id: orderId,
    from_status: from,
    to_status: to,
    actor_user_id: actorUserId,
    note: note?.trim() || null,
  });

  if (transitionError) {
    await supabase
      .from('orders')
      .update({
        cod_status: from,
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId)
      .eq('merchant_account_id', merchantAccountId)
      .eq('cod_status', to);

    return { ok: false, errorCode: 'transition_log_failed' };
  }

  return { ok: true };
}

export async function getOrders({ codStatus }: GetOrdersInput = {}): Promise<OrderListItem[]> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  let query = supabase
    .from('orders')
    .select(
      'id, customer_id, order_number, total_amount, currency, cod_status, created_at_shopify, customer:customer_id(full_name, phone)',
    )
    .order('created_at_shopify', { ascending: false, nullsFirst: false });

  if (codStatus) {
    query = query.eq('cod_status', codStatus);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return (data ?? []) as OrderListItem[];
}

export async function getOrderById(id: string): Promise<OrderDetail | null> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const { data, error } = await supabase
    .from('orders')
    .select('*, customer:customer_id(full_name, phone, email, shipping_address)')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as OrderDetail | null;
}

export async function getOrderTimeline(orderId: string): Promise<OrderTimelineEvent[]> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());

  const [transitionResult, callResult] = await Promise.all([
    supabase
      .from('order_state_transition')
      .select('id, actor_user_id, created_at, from_status, note, to_status')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false }),
    supabase
      .from('call_log')
      .select('id, agent_user_id, created_at, next_action_at, note_fr, outcome')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false }),
  ]);

  if (transitionResult.error) {
    throw transitionResult.error;
  }

  if (callResult.error) {
    throw callResult.error;
  }

  const transitions: OrderTransitionTimelineEvent[] = (transitionResult.data ?? [])
    .map((transition) => {
      const toStatus = toOrderStatus(transition.to_status);

      if (!toStatus) {
        return null;
      }

      return {
        id: transition.id,
        type: 'transition' as const,
        createdAt: transition.created_at,
        actorUserId: transition.actor_user_id,
        fromStatus: toOrderStatus(transition.from_status),
        toStatus,
        note: transition.note,
      };
    })
    .filter((event): event is OrderTransitionTimelineEvent => event !== null);

  const calls: OrderCallTimelineEvent[] = (callResult.data ?? []).map((call) => ({
    id: call.id,
    type: 'call',
    createdAt: call.created_at,
    actorUserId: call.agent_user_id,
    outcome: toCallOutcome(call.outcome),
    note: call.note_fr,
    nextActionAt: call.next_action_at,
  }));

  return [...transitions, ...calls].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const transitionOrderStatusAction = authActionClient
  .metadata({ actionName: 'orders.transition_status', section: 'orders' })
  .inputSchema(
    z.object({
      orderId: z.string().uuid(),
      to: z.enum(orderStatuses),
      note: z.string().trim().max(500).optional(),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, cod_status, merchant_account_id')
      .eq('id', parsedInput.orderId)
      .maybeSingle();

    if (orderError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    if (!order) {
      return { ok: false as const, errorCode: 'order_not_found' as const };
    }

    if (!isOrderStatus(order.cod_status)) {
      return { ok: false as const, errorCode: 'invalid_current_status' as const };
    }

    try {
      assertTransition(order.cod_status, parsedInput.to);
    } catch (error) {
      if (error instanceof IllegalTransitionError) {
        return transitionErrorPayload(error);
      }

      throw error;
    }

    const transition = await applyOrderTransition({
      actorUserId: ctx.user.id,
      from: order.cod_status,
      merchantAccountId: order.merchant_account_id,
      note: parsedInput.note,
      orderId: order.id,
      supabase,
      to: parsedInput.to,
    });

    if (!transition.ok) {
      return { ok: false as const, errorCode: transition.errorCode };
    }

    const auditError = await writeOrderAuditLog({
      action: 'order.transition',
      actorUserId: ctx.user.id,
      merchantAccountId: order.merchant_account_id,
      orderId: order.id,
      payload: {
        from: order.cod_status,
        to: parsedInput.to,
        note: parsedInput.note ?? null,
      },
    });

    if (auditError) {
      return { ok: false as const, errorCode: 'audit_failed' as const };
    }

    revalidateOrderPaths(order.id);

    return { ok: true as const, newStatus: parsedInput.to };
  });

const logCallInputSchema = z
  .object({
    orderId: z.string().uuid(),
    outcome: z.enum(callOutcomes),
    note: z.string().trim().max(500).optional(),
    nextActionAt: z.string().datetime().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.outcome === 'A_RAPPELER' && !input.nextActionAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'La date du prochain rappel est requise.',
        path: ['nextActionAt'],
      });
    }
  });

function getAutoTransitionTarget(outcome: CallOutcome): OrderStatus {
  if (outcome === 'SANS_REPONSE' || outcome === 'A_RAPPELER') {
    return 'TENTEE';
  }

  return outcome;
}

export const logCallAction = authActionClient
  .metadata({ actionName: 'orders.log_call', section: 'orders' })
  .inputSchema(logCallInputSchema)
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, cod_status, merchant_account_id')
      .eq('id', parsedInput.orderId)
      .maybeSingle();

    if (orderError) {
      return { ok: false as const, errorCode: 'call_log_failed' as const };
    }

    if (!order) {
      return { ok: false as const, errorCode: 'order_not_found' as const };
    }

    const nextActionAt =
      parsedInput.outcome === 'A_RAPPELER' ? (parsedInput.nextActionAt ?? null) : null;

    const { error: callError } = await supabase.from('call_log').insert({
      merchant_account_id: order.merchant_account_id,
      order_id: order.id,
      agent_user_id: ctx.user.id,
      outcome: parsedInput.outcome,
      note_fr: parsedInput.note?.trim() || null,
      next_action_at: nextActionAt,
    });

    if (callError) {
      return { ok: false as const, errorCode: 'call_log_failed' as const };
    }

    const autoTransitionTarget = getAutoTransitionTarget(parsedInput.outcome);
    let transitioned = false;
    let transitionErrorCode:
      | 'invalid_current_status'
      | 'transition_log_failed'
      | 'update_failed'
      | null = null;

    if (isOrderStatus(order.cod_status)) {
      try {
        assertTransition(order.cod_status, autoTransitionTarget);
        const transition = await applyOrderTransition({
          actorUserId: ctx.user.id,
          from: order.cod_status,
          merchantAccountId: order.merchant_account_id,
          note: parsedInput.note,
          orderId: order.id,
          supabase,
          to: autoTransitionTarget,
        });

        transitioned = transition.ok;
        transitionErrorCode = transition.ok ? null : transition.errorCode;
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) {
          throw error;
        }
      }
    } else {
      transitionErrorCode = 'invalid_current_status';
    }

    const auditError = await writeOrderAuditLog({
      action: 'call.logged',
      actorUserId: ctx.user.id,
      merchantAccountId: order.merchant_account_id,
      orderId: order.id,
      payload: {
        outcome: parsedInput.outcome,
        note: parsedInput.note ?? null,
        nextActionAt,
        transitioned,
        newStatus: transitioned ? autoTransitionTarget : null,
        transitionErrorCode,
      },
    });

    if (auditError) {
      return {
        ok: false as const,
        callLogged: true as const,
        transitioned,
        errorCode: 'audit_failed' as const,
      };
    }

    revalidateOrderPaths(order.id);

    return {
      ok: true as const,
      callLogged: true as const,
      transitioned,
      ...(transitioned ? { newStatus: autoTransitionTarget } : {}),
    };
  });

export const updateCodStatusAction = authActionClient
  .metadata({ actionName: 'orders.update_cod_status', section: 'orders' })
  .inputSchema(
    z.object({
      orderId: z.string().uuid(),
      codStatus: z.enum(codStatuses),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const merchantAccount = await getMerchantAccount();

    if (!merchantAccount) {
      return { ok: false as const, errorCode: 'merchant_not_found' as const };
    }

    const admin = createSupabaseAdminClient();
    const { data: existingOrder, error: selectError } = await admin
      .from('orders')
      .select('id, cod_status')
      .eq('id', parsedInput.orderId)
      .eq('merchant_account_id', merchantAccount.id)
      .maybeSingle();

    if (selectError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    if (!existingOrder) {
      return { ok: false as const, errorCode: 'order_not_found' as const };
    }

    const { error: updateError } = await admin
      .from('orders')
      .update({
        cod_status: parsedInput.codStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('id', parsedInput.orderId)
      .eq('merchant_account_id', merchantAccount.id);

    if (updateError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    const { error: auditError } = await admin.from('audit_log').insert({
      merchant_account_id: merchantAccount.id,
      actor_user_id: ctx.user.id,
      action: 'order.cod_status_changed',
      resource_type: 'orders',
      resource_id: parsedInput.orderId,
      payload: {
        from: existingOrder.cod_status,
        to: parsedInput.codStatus,
      },
    });

    if (auditError) {
      return { ok: false as const, errorCode: 'audit_failed' as const };
    }

    return { ok: true as const };
  });
