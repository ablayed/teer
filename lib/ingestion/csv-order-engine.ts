import { normalizeSenegalPhone } from '@/lib/address/phone-sn';
import type { PersistableCanonicalOrder, ResolvedShopContext } from '@/lib/ingestion/canonical';
import { defaultOrderCurrency, mapFlexibleOrderAddress } from '@/lib/ingestion/order-normalization';
import { resolveOrderLines } from '@/lib/stock/order-line-resolution';
import type { Database, Json } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

export type CsvOrderWriteResult =
  | { ok: true; orderId: string }
  | { ok: false; code: 'already_imported' | 'customer_write_failed' | 'order_write_failed' };

async function resolveCustomer(
  supabase: AdminClient,
  context: ResolvedShopContext,
  order: PersistableCanonicalOrder,
): Promise<string | null> {
  const phone = order.data.customer.phone;
  const phoneE164 = phone ? normalizeSenegalPhone(phone) : null;

  // Même règle que la saisie manuelle (findOrCreateCustomerByPhone) : sans numéro normalisable,
  // pas d'identité client dédoublonnable, donc pas d'écriture.
  if (!phoneE164) return null;

  // Rapprochement borné à la boutique du contexte : un client d'une autre boutique du même compte
  // n'est jamais rattaché (create_csv_order le refuserait de toute façon, r2_csv_customer_context_mismatch).
  const { data: existing, error: lookupError } = await supabase
    .from('customer')
    .select('id')
    .eq('merchant_account_id', context.merchantAccountId)
    .eq('shop_id', context.shopId)
    .eq('phone_e164', phoneE164)
    .maybeSingle();
  if (lookupError) return null;
  if (existing) return existing.id;

  const { data, error } = await supabase
    .from('customer')
    .insert({
      merchant_account_id: context.merchantAccountId,
      shop_id: context.shopId,
      source: 'manual',
      full_name: order.data.customer.fullName,
      phone,
      phone_e164: phoneE164,
      address: mapFlexibleOrderAddress(order.data.customer.address),
      shipping_address: order.data.shippingAddress as Json,
    })
    .select('id')
    .single();
  return error || !data ? null : data.id;
}

export async function writeCsvCanonicalOrder(
  supabase: AdminClient,
  context: ResolvedShopContext,
  order: PersistableCanonicalOrder,
): Promise<CsvOrderWriteResult> {
  const { data: existing } = await supabase
    .from('external_ref')
    .select('id')
    .eq('merchant_account_id', context.merchantAccountId)
    .eq('shop_id', context.shopId)
    .is('store_connection_id', null)
    .eq('source_namespace', 'csv')
    .eq('entity_type', 'order')
    .eq('external_id', order.externalOrderId)
    .maybeSingle();

  if (existing) return { ok: false, code: 'already_imported' };

  const customerId = await resolveCustomer(supabase, context, order);
  if (!customerId) return { ok: false, code: 'customer_write_failed' };

  const lines = await resolveOrderLines(supabase, {
    merchantAccountId: context.merchantAccountId,
    shopId: context.shopId,
    lineItems: order.data.lines.map((line) => ({
      title: line.title,
      sku: line.sku,
      quantity: line.quantity,
      price: line.unitAmount ?? undefined,
      product_id: line.productId,
    })),
  });

  const { data: event } = await supabase
    .from('ingestion_event')
    .insert({
      merchant_account_id: context.merchantAccountId,
      shop_id: context.shopId,
      store_connection_id: null,
      platform: 'csv',
      topic: 'orders/import',
      resource_kind: 'order',
      resource_external_id: order.externalOrderId,
      ordering_signal: order.data.updatedAt,
      status: 'processing',
      attempt_count: 1,
      lease_until: new Date(Date.now() + 5 * 60_000).toISOString(),
      triggered_at: order.data.eventAt,
    })
    .select('id')
    .single();

  const { data: orderId, error } = await supabase.rpc('create_csv_order', {
    p_merchant_account_id: context.merchantAccountId,
    p_shop_id: context.shopId,
    p_customer_id: customerId,
    p_order_key: order.externalOrderId,
    p_order_number: order.data.orderNumber ?? order.externalOrderId,
    p_total_amount: order.data.totalAmount,
    p_currency: defaultOrderCurrency(order.data.currency),
    p_items_summary: order.data.lines.map((line) => ({
      title: line.title,
      sku: line.sku,
      quantity: line.quantity,
      price: line.unitAmount,
      product_id: line.productId,
    })),
    p_shipping_address: order.data.shippingAddress as Json,
    p_lines: lines.map((line) => ({
      product_id: line.product_id,
      raw_title: line.raw_title,
      raw_sku: line.raw_sku,
      qty: line.qty,
      match_status: line.match_status,
    })),
  });

  if (error || !orderId) {
    const alreadyImported = error?.code === '23505';
    // Terminal, jamais retryable : aucun mécanisme ne rejoue un import CSV (le fichier n'est pas
    // conservé). Un conflit sur l'index natif est le rejeu concurrent attendu, nommé comme tel.
    if (event) {
      await supabase
        .from('ingestion_event')
        .update({
          status: 'terminal',
          lease_until: null,
          completed_at: new Date().toISOString(),
          last_error_code: alreadyImported
            ? 'csv_order_already_imported'
            : 'csv_order_write_failed',
        })
        .eq('id', event.id);
    }
    return { ok: false, code: alreadyImported ? 'already_imported' : 'order_write_failed' };
  }

  if (event) {
    await supabase
      .from('ingestion_event')
      .update({ status: 'done', lease_until: null, completed_at: new Date().toISOString() })
      .eq('id', event.id);
  }
  return { ok: true, orderId };
}
