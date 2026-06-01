'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import type { Database, Json, Tables } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

type MerchantSettingsRow = Tables<'merchant_settings'>;

const settingsSchema = z.object({
  cogsKnown: z.boolean(),
  defaultDeliveryCostMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  freeMoneyFeeBps: z.number().int().min(0).max(10_000),
  merchantLevyBps: z.number().int().min(0).max(10_000),
  orangeMoneyFeeBps: z.number().int().min(0).max(10_000),
  transferTaxBps: z.number().int().min(0).max(10_000),
  transferTaxCapMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  waveFeeBps: z.number().int().min(0).max(10_000),
});

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function toClientSettings(row: MerchantSettingsRow) {
  return {
    cogsKnown: row.cogs_known,
    defaultDeliveryCostMinor: row.default_delivery_cost_minor,
    freeMoneyFeeBps: row.free_money_fee_bps,
    merchantAccountId: row.merchant_account_id,
    merchantLevyBps: row.merchant_levy_bps,
    orangeMoneyFeeBps: row.orange_money_fee_bps,
    transferTaxBps: row.transfer_tax_bps,
    transferTaxCapMinor: row.transfer_tax_cap_minor,
    updatedAt: row.updated_at,
    waveFeeBps: row.wave_fee_bps,
  };
}

function toDatabaseSettings(input: z.infer<typeof settingsSchema>) {
  return {
    cogs_known: input.cogsKnown,
    default_delivery_cost_minor: input.defaultDeliveryCostMinor,
    free_money_fee_bps: input.freeMoneyFeeBps,
    merchant_levy_bps: input.merchantLevyBps,
    orange_money_fee_bps: input.orangeMoneyFeeBps,
    transfer_tax_bps: input.transferTaxBps,
    transfer_tax_cap_minor: input.transferTaxCapMinor,
    wave_fee_bps: input.waveFeeBps,
  };
}

async function writeSettingsAuditLog({
  actorUserId,
  after,
  before,
  merchantAccountId,
}: {
  actorUserId: string;
  after: Json;
  before: Json;
  merchantAccountId: string;
}) {
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from('audit_log').insert({
    action: 'fee_settings_updated',
    actor_user_id: actorUserId,
    merchant_account_id: merchantAccountId,
    payload: { after, before },
    resource_id: merchantAccountId,
    resource_type: 'merchant_settings',
  });

  return error;
}

async function ensureMerchantSettings(
  merchantAccountId: string,
): Promise<MerchantSettingsRow | null> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('merchant_settings')
    .upsert({ merchant_account_id: merchantAccountId }, { onConflict: 'merchant_account_id' })
    .select('*')
    .single();

  if (error) {
    return null;
  }

  return data;
}

function revalidateFinancePaths() {
  revalidatePath('/finances');
  revalidatePath('/parametres');
}

export const getMerchantSettingsAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'finance.settings.get', section: 'finance' })
  .inputSchema(z.object({}))
  .action(async ({ ctx }) => {
    const settings = await ensureMerchantSettings(ctx.member.merchantAccountId);

    if (!settings) {
      return { ok: false as const, errorCode: 'settings_failed' as const };
    }

    return { ok: true as const, settings: toClientSettings(settings) };
  });

export const updateMerchantSettingsAction = requireRole('owner')
  .metadata({ actionName: 'finance.settings.update', section: 'finance' })
  .inputSchema(settingsSchema)
  .action(async ({ ctx, parsedInput }) => {
    const admin = createSupabaseAdminClient();
    const merchantAccountId = ctx.member.merchantAccountId;
    const before = await ensureMerchantSettings(merchantAccountId);

    if (!before) {
      return { ok: false as const, errorCode: 'settings_failed' as const };
    }

    const { data: after, error } = await admin
      .from('merchant_settings')
      .update(toDatabaseSettings(parsedInput))
      .eq('merchant_account_id', merchantAccountId)
      .select('*')
      .single();

    if (error || !after) {
      return { ok: false as const, errorCode: 'settings_failed' as const };
    }

    const auditError = await writeSettingsAuditLog({
      actorUserId: ctx.user.id,
      after: after as Json,
      before: before as Json,
      merchantAccountId,
    });

    if (auditError) {
      return { ok: false as const, errorCode: 'audit_failed' as const };
    }

    revalidateFinancePaths();

    return { ok: true as const, settings: toClientSettings(after) };
  });
