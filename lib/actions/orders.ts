'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { performTransitionForContext } from '@/lib/actions/transitions';
import { normalizeSenegalPhone } from '@/lib/address/phone-sn';
import { type OrderStatus, orderStatuses } from '@/lib/domain/order-state-machine';
import {
  type TransitionAction,
  getAllowedTransitionActionsForDimensions,
  getTransitionActionForTarget,
  paymentChannelsAtDelivery,
  resolveOrderDimensions,
} from '@/lib/domain/order-transition-actions';
import { env } from '@/lib/env';
import {
  type CallOutcome,
  callOutcomes,
  logCallInputSchema,
} from '@/lib/orders/call-log-validation';
import { type CodStatus, codStatuses } from '@/lib/orders/status';
import { resolveAndInsertOrderLines } from '@/lib/stock/order-line-resolution';
import type { Database, Json, Tables, TablesUpdate } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { type TeamRole, isTeamRole } from '@/lib/team/permissions';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

type CustomerSummary = Pick<Tables<'customer'>, 'full_name' | 'phone'>;
type CustomerDetail = Pick<
  Tables<'customer'>,
  'email' | 'full_name' | 'phone' | 'shipping_address'
>;
export type DeliveryAddress = Tables<'delivery_address'>;

export type OrderListItem = Pick<
  Tables<'orders'>,
  | 'cod_status'
  | 'call_state'
  | 'created_at'
  | 'created_at_shopify'
  | 'currency'
  | 'cash_state'
  | 'customer_id'
  | 'delivery_state'
  | 'id'
  | 'items_summary'
  | 'next_contact_at'
  | 'order_state'
  | 'order_number'
  | 'scheduled_for'
  | 'shipping_address'
  | 'source'
  | 'total_amount'
> & {
  allowedActions: TransitionAction[];
  customer: CustomerSummary | null;
};

export type OrderDetail = Tables<'orders'> & {
  allowedActions: TransitionAction[];
  customer: CustomerDetail | null;
  customer_delivery_address: DeliveryAddress | null;
  delivery_address: DeliveryAddress | null;
};

type GetOrdersInput = {
  codStatus?: CodStatus;
};

type SupabaseServerClient = SupabaseClient<Database>;
const manualOrderSources = ['manual', 'whatsapp', 'instagram', 'tiktok', 'facebook'] as const;

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

async function getCurrentMemberRole(supabase: SupabaseServerClient): Promise<TeamRole | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: member, error } = await supabase
    .from('merchant_member')
    .select('role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  if (error || !member || !isTeamRole(member.role)) {
    return null;
  }

  return member.role;
}

function allowedActionsForOrderRow(
  order: Pick<
    Tables<'orders'>,
    'call_state' | 'cash_state' | 'cod_status' | 'delivery_state' | 'order_state'
  >,
  role: TeamRole | null,
): TransitionAction[] {
  return role ? getAllowedTransitionActionsForDimensions(resolveOrderDimensions(order), role) : [];
}

function revalidateOrderPaths(orderId: string) {
  revalidatePath('/commandes');
  revalidatePath(`/commandes/${orderId}`);
}

function toCallOutcome(value: string): CallOutcome {
  return isCallOutcome(value) ? value : 'SANS_REPONSE';
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

async function getMerchantAccountIdForActor(
  supabase: SupabaseServerClient,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data.merchant_account_id;
}

async function findOrCreateCustomerByPhone({
  email,
  fullName,
  merchantAccountId,
  phone,
  shippingAddress,
  supabase,
}: {
  email?: string;
  fullName?: string;
  merchantAccountId: string;
  phone: string;
  shippingAddress: Json | null;
  supabase: SupabaseServerClient;
}): Promise<
  { ok: true; customerId: string; normalizedPhone: string } | { message: string; ok: false }
> {
  const normalizedPhone = normalizeSenegalPhone(phone);

  if (!normalizedPhone) {
    return {
      ok: false,
      message: 'Numéro de téléphone sénégalais invalide.',
    };
  }

  const { data: matches, error: selectError } = await supabase
    .from('customer')
    .select('id, full_name, email, shipping_address, created_at')
    .eq('merchant_account_id', merchantAccountId)
    .eq('phone', normalizedPhone)
    .order('created_at', { ascending: true })
    .limit(2);

  if (selectError) {
    return { ok: false, message: 'Impossible de verifier le client existant.' };
  }

  const existingCustomer = matches?.[0] ?? null;

  if (existingCustomer) {
    const customerPatch: TablesUpdate<'customer'> = {
      ...(existingCustomer.full_name ? {} : fullName ? { full_name: fullName } : {}),
      ...(existingCustomer.email ? {} : email ? { email } : {}),
      ...(existingCustomer.shipping_address
        ? {}
        : shippingAddress
          ? { shipping_address: shippingAddress }
          : {}),
    };

    if (Object.keys(customerPatch).length > 0) {
      const { error: updateError } = await supabase
        .from('customer')
        .update(customerPatch)
        .eq('id', existingCustomer.id);

      if (updateError) {
        return { ok: false, message: 'Impossible de mettre a jour le client existant.' };
      }
    }

    return {
      ok: true,
      customerId: existingCustomer.id,
      normalizedPhone,
    };
  }

  const { data: insertedCustomer, error: insertError } = await supabase
    .from('customer')
    .insert({
      merchant_account_id: merchantAccountId,
      full_name: fullName ?? null,
      phone: normalizedPhone,
      email: email ?? null,
      shipping_address: shippingAddress,
    })
    .select('id')
    .single();

  if (insertError || !insertedCustomer) {
    return { ok: false, message: 'Impossible de creer le client.' };
  }

  return {
    ok: true,
    customerId: insertedCustomer.id,
    normalizedPhone,
  };
}

export async function getOrders({ codStatus }: GetOrdersInput = {}): Promise<OrderListItem[]> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const role = await getCurrentMemberRole(supabase);
  let query = supabase
    .from('orders')
    .select(
      'id, customer_id, order_number, total_amount, currency, cod_status, order_state, call_state, delivery_state, cash_state, items_summary, shipping_address, created_at, created_at_shopify, next_contact_at, scheduled_for, source, customer:customer_id(full_name, phone)',
    )
    .order('created_at_shopify', { ascending: false, nullsFirst: false });

  if (codStatus) {
    query = query.eq('cod_status', codStatus);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return ((data ?? []) as Array<Omit<OrderListItem, 'allowedActions'>>).map((order) => ({
    ...order,
    allowedActions: allowedActionsForOrderRow(order, role),
  }));
}

export async function getOrderById(id: string): Promise<OrderDetail | null> {
  const supabase = asTypedSupabaseClient(await createSupabaseServerClient());
  const role = await getCurrentMemberRole(supabase);
  const { data, error } = await supabase
    .from('orders')
    .select('*, customer:customer_id(full_name, phone, email, shipping_address)')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  const [orderAddressResult, customerAddressResult] = await Promise.all([
    supabase
      .from('delivery_address')
      .select('*')
      .eq('merchant_account_id', data.merchant_account_id)
      .eq('order_id', data.id)
      .maybeSingle(),
    data.customer_id
      ? supabase
          .from('delivery_address')
          .select('*')
          .eq('merchant_account_id', data.merchant_account_id)
          .eq('customer_id', data.customer_id)
          .is('order_id', null)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (orderAddressResult.error) {
    throw orderAddressResult.error;
  }

  if (customerAddressResult.error) {
    throw customerAddressResult.error;
  }

  return {
    ...(data as Tables<'orders'> & { customer: CustomerDetail | null }),
    allowedActions: allowedActionsForOrderRow(data, role),
    delivery_address: orderAddressResult.data,
    customer_delivery_address: customerAddressResult.data,
  };
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

export const createManualOrderAction = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'orders.create_manual', section: 'orders' })
  .inputSchema(
    z.object({
      customerName: z.string().trim().min(2).max(120),
      phone: z.string().trim().min(1).max(40),
      source: z.enum(manualOrderSources).default('manual'),
      lines: z
        .array(
          z.object({
            productId: z.string().uuid(),
            quantity: z.number().int().min(1).max(999),
            unitPrice: z.number().min(0),
          }),
        )
        .min(1)
        .max(20),
      address: z.string().trim().max(500).optional(),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const merchantAccountId = await getMerchantAccountIdForActor(supabase, ctx.user.id);

    if (!merchantAccountId) {
      return {
        ok: false as const,
        errorCode: 'merchant_not_found' as const,
        message: "Aucun compte marchand n'a ete trouve.",
      };
    }

    const shippingAddress = parsedInput.address
      ? ({
          address1: parsedInput.address,
        } satisfies Json)
      : null;

    const productIds = parsedInput.lines.map((l) => l.productId);
    const { data: products, error: productError } = await supabase
      .from('product')
      .select('id, title, sku')
      .eq('merchant_account_id', merchantAccountId)
      .in('id', productIds);

    if (productError || !products || products.length !== productIds.length) {
      return {
        ok: false as const,
        errorCode: 'update_failed' as const,
        message: 'Un ou plusieurs produits sont introuvables.',
      };
    }

    const productMap = new Map(products.map((p) => [p.id, p]));

    const customer = await findOrCreateCustomerByPhone({
      merchantAccountId,
      phone: parsedInput.phone,
      fullName: parsedInput.customerName,
      shippingAddress,
      supabase,
    });

    if (!customer.ok) {
      return {
        ok: false as const,
        errorCode: 'update_failed' as const,
        message: customer.message,
      };
    }

    const itemsSummary = parsedInput.lines.map((line) => {
      const product = productMap.get(line.productId);
      return {
        product_id: line.productId,
        title: product?.title ?? '',
        sku: product?.sku ?? null,
        quantity: line.quantity,
        price: line.unitPrice,
      };
    });
    const totalAmount = parsedInput.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);

    const orderNumber = `MAN-${Date.now()}`;
    const { data: order, error: insertError } = await supabase
      .from('orders')
      .insert({
        merchant_account_id: merchantAccountId,
        customer_id: customer.customerId,
        shopify_order_id: null,
        source: parsedInput.source,
        order_number: orderNumber,
        total_amount: totalAmount,
        currency: 'XOF',
        items_summary: itemsSummary,
        shipping_address: shippingAddress,
        order_state: 'open',
        call_state: 'to_call',
        delivery_state: 'unassigned',
        cash_state: 'not_due',
      })
      .select('id')
      .single();

    if (insertError || !order) {
      return {
        ok: false as const,
        errorCode: 'update_failed' as const,
        message: "La commande manuelle n'a pas pu etre creee.",
      };
    }

    // Best-effort: resolution failure never blocks order creation.
    await resolveAndInsertOrderLines(supabase, {
      merchantAccountId,
      orderId: order.id,
      lineItems: itemsSummary,
    }).catch(() => undefined);

    revalidatePath('/commandes');
    revalidatePath('/tableau');

    return {
      ok: true as const,
      orderId: order.id,
    };
  });

export const transitionOrderStatusAction = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'orders.transition_status', section: 'orders' })
  .inputSchema(
    z.object({
      orderId: z.string().uuid(),
      to: z.enum(orderStatuses),
      note: z.string().trim().max(500).optional(),
      paymentChannelAtDelivery: z.enum(paymentChannelsAtDelivery).optional(),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const action = getTransitionActionForTarget(parsedInput.to, ctx.member.role);

    if (!action) {
      return {
        ok: false as const,
        errorCode: 'forbidden' as const,
        message: "Vous n'avez pas le droit d'executer cette action.",
      };
    }

    const transition = await performTransitionForContext({
      action,
      actorUserId: ctx.user.id,
      orderId: parsedInput.orderId,
      payload: {
        note: parsedInput.note,
        paymentChannelAtDelivery: parsedInput.paymentChannelAtDelivery,
      },
      role: ctx.member.role,
      supabase: asTypedSupabaseClient(ctx.supabase),
    });

    if (!transition.ok) {
      return transition;
    }

    return {
      ok: true as const,
      newStatus: transition.order.cod_status,
      order: transition.order,
      allowedActions: transition.allowedActions,
    };
  });

function getAutoTransitionTarget(outcome: CallOutcome): OrderStatus {
  if (outcome === 'SANS_REPONSE' || outcome === 'A_RAPPELER') {
    return 'TENTEE';
  }

  return outcome;
}

export const logCallAction = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'orders.log_call', section: 'orders' })
  .inputSchema(logCallInputSchema)
  .action(async ({ ctx, parsedInput }) => {
    const supabase = asTypedSupabaseClient(ctx.supabase);
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select(
        'id, merchant_account_id, cod_status, order_state, call_state, delivery_state, cash_state',
      )
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
      | 'forbidden'
      | 'audit_failed'
      | 'illegal_transition'
      | 'invalid_current_status'
      | 'order_not_found'
      | 'update_failed'
      | null = null;

    if (isOrderStatus(order.cod_status)) {
      const transitionAction = getTransitionActionForTarget(autoTransitionTarget, ctx.member.role);

      if (transitionAction) {
        const transition = await performTransitionForContext({
          action: transitionAction,
          actorUserId: ctx.user.id,
          orderId: order.id,
          payload: {
            nextContactAt: nextActionAt ?? undefined,
            note: parsedInput.note,
          },
          role: ctx.member.role,
          supabase,
        });

        transitioned = transition.ok;
        transitionErrorCode =
          transition.ok || transition.errorCode === 'audit_failed' ? null : transition.errorCode;
      } else {
        transitionErrorCode = 'forbidden';
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

export const updateCodStatusAction = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'orders.update_cod_status', section: 'orders' })
  .inputSchema(
    z.object({
      orderId: z.string().uuid(),
      codStatus: z.enum(codStatuses),
    }),
  )
  .action(async ({ ctx, parsedInput }) => {
    const action = getTransitionActionForTarget(parsedInput.codStatus, ctx.member.role);

    if (!action) {
      return { ok: false as const, errorCode: 'forbidden' as const };
    }

    const transition = await performTransitionForContext({
      action,
      actorUserId: ctx.user.id,
      orderId: parsedInput.orderId,
      role: ctx.member.role,
      supabase: asTypedSupabaseClient(ctx.supabase),
    });

    if (!transition.ok) {
      return { ok: false as const, errorCode: transition.errorCode };
    }

    return { ok: true as const };
  });
