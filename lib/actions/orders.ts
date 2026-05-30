'use server';

import { getMerchantAccount } from '@/lib/actions/merchant';
import { authActionClient } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { type CodStatus, codStatuses } from '@/lib/orders/status';
import type { Database, Tables } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

type CustomerSummary = Pick<Tables<'customer'>, 'full_name' | 'phone'>;
type CustomerDetail = Pick<
  Tables<'customer'>,
  'email' | 'full_name' | 'phone' | 'shipping_address'
>;

export type OrderListItem = Pick<
  Tables<'orders'>,
  'cod_status' | 'created_at_shopify' | 'customer_id' | 'id' | 'order_number' | 'total_amount'
> & {
  customer: CustomerSummary | null;
};

export type OrderDetail = Tables<'orders'> & {
  customer: CustomerDetail | null;
};

type GetOrdersInput = {
  codStatus?: CodStatus;
};

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function getOrders({ codStatus }: GetOrdersInput = {}): Promise<OrderListItem[]> {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('orders')
    .select(
      'id, customer_id, order_number, total_amount, cod_status, created_at_shopify, customer:customer_id(full_name, phone)',
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
  const supabase = await createSupabaseServerClient();
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
