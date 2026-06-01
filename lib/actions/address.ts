'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { normalizeSenegalPhone } from '@/lib/address/phone-sn';
import { env } from '@/lib/env';
import type { Database, Json, Tables } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

type SupabaseServerClient = SupabaseClient<Database>;
type DeliveryAddressInsert = Database['public']['Tables']['delivery_address']['Insert'];
type DeliveryAddressUpdate = Database['public']['Tables']['delivery_address']['Update'];

const upsertOrderDeliveryAddressSchema = z.object({
  orderId: z.string().uuid(),
  quartierCommune: z.string().trim().min(2).max(160),
  ville: z.string().trim().min(2).max(80).default('Dakar'),
  repere: z.string().trim().max(240).optional(),
  indicationsAcces: z.string().trim().max(500).optional(),
  gpsLat: z.number().finite().min(-90).max(90).nullable().optional(),
  gpsLng: z.number().finite().min(-180).max(180).nullable().optional(),
  telephonePrincipal: z.string().trim().min(1),
  telephoneAlternatif: z.string().trim().optional(),
});

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function nullableText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function writeAddressAuditLog({
  actorUserId,
  merchantAccountId,
  orderId,
  payload,
}: {
  actorUserId: string;
  merchantAccountId: string;
  orderId: string;
  payload?: Json;
}) {
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from('audit_log').insert({
    merchant_account_id: merchantAccountId,
    actor_user_id: actorUserId,
    action: 'delivery_address.updated',
    resource_type: 'delivery_address',
    resource_id: orderId,
    payload,
  });

  return error;
}

export const upsertOrderDeliveryAddressAction = requireRole('owner', 'manager', 'agent')
  .metadata({ actionName: 'address.upsert_order_delivery', section: 'orders' })
  .inputSchema(upsertOrderDeliveryAddressSchema)
  .action(async ({ ctx, parsedInput }) => {
    const supabase = ctx.supabase as unknown as SupabaseServerClient;
    const telephonePrincipal = normalizeSenegalPhone(parsedInput.telephonePrincipal);
    const telephoneAlternatif = parsedInput.telephoneAlternatif
      ? normalizeSenegalPhone(parsedInput.telephoneAlternatif)
      : null;

    if (!telephonePrincipal || (parsedInput.telephoneAlternatif && !telephoneAlternatif)) {
      return { ok: false as const, errorCode: 'invalid_phone' as const };
    }

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, customer_id, merchant_account_id')
      .eq('id', parsedInput.orderId)
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .maybeSingle();

    if (orderError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    if (!order) {
      return { ok: false as const, errorCode: 'order_not_found' as const };
    }

    const now = new Date().toISOString();
    const baseAddress = {
      quartier_commune: parsedInput.quartierCommune,
      ville: parsedInput.ville,
      repere: nullableText(parsedInput.repere),
      indications_acces: nullableText(parsedInput.indicationsAcces),
      gps_lat: parsedInput.gpsLat ?? null,
      gps_lng: parsedInput.gpsLng ?? null,
      telephone_principal: telephonePrincipal,
      telephone_alternatif: telephoneAlternatif,
      updated_at: now,
    } satisfies DeliveryAddressUpdate;

    const { data: existingOrderAddress, error: existingOrderError } = await supabase
      .from('delivery_address')
      .select('id')
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .eq('order_id', order.id)
      .maybeSingle();

    if (existingOrderError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    const orderAddressPayload = {
      ...baseAddress,
      merchant_account_id: ctx.member.merchantAccountId,
      customer_id: order.customer_id,
      order_id: order.id,
    } satisfies DeliveryAddressInsert;

    const orderAddressResult = existingOrderAddress
      ? await supabase
          .from('delivery_address')
          .update(baseAddress)
          .eq('id', existingOrderAddress.id)
          .eq('merchant_account_id', ctx.member.merchantAccountId)
      : await supabase.from('delivery_address').insert(orderAddressPayload);

    if (orderAddressResult.error) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    if (order.customer_id) {
      const { data: existingCustomerAddress, error: existingCustomerError } = await supabase
        .from('delivery_address')
        .select('id')
        .eq('merchant_account_id', ctx.member.merchantAccountId)
        .eq('customer_id', order.customer_id)
        .is('order_id', null)
        .maybeSingle();

      if (existingCustomerError) {
        return { ok: false as const, errorCode: 'update_failed' as const };
      }

      const customerAddressPayload = {
        ...baseAddress,
        merchant_account_id: ctx.member.merchantAccountId,
        customer_id: order.customer_id,
        order_id: null,
      } satisfies DeliveryAddressInsert;

      const customerAddressResult = existingCustomerAddress
        ? await supabase
            .from('delivery_address')
            .update(baseAddress)
            .eq('id', existingCustomerAddress.id)
            .eq('merchant_account_id', ctx.member.merchantAccountId)
        : await supabase.from('delivery_address').insert(customerAddressPayload);

      if (customerAddressResult.error) {
        return { ok: false as const, errorCode: 'update_failed' as const };
      }
    }

    const auditError = await writeAddressAuditLog({
      actorUserId: ctx.user.id,
      merchantAccountId: ctx.member.merchantAccountId,
      orderId: order.id,
      payload: {
        orderId: order.id,
        customerId: order.customer_id,
        hasGps: parsedInput.gpsLat !== null && parsedInput.gpsLng !== null,
      },
    });

    if (auditError) {
      return { ok: false as const, errorCode: 'audit_failed' as const };
    }

    revalidatePath('/commandes');
    revalidatePath(`/commandes/${order.id}`);

    return { ok: true as const };
  });
