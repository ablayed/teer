'use server';

import { authActionClient } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { isValidPhoneSN, toWhatsAppLink } from '@/lib/format/phone';
import type { Database, Tables } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

const countryCodes = ['SN', 'CI', 'BJ', 'TG', 'BF', 'ML'] as const;

const merchantProfileSchema = z.object({
  shopName: z.string().trim().min(2).max(100),
  countryCode: z.enum(countryCodes),
  ownerFullName: z.string().trim().min(2).max(100),
  whatsapp: z.string().trim().optional(),
});

type MerchantAccount = Tables<'merchant_account'>;
type MerchantProfileInput = z.infer<typeof merchantProfileSchema>;
type MerchantActionErrorCode =
  | 'invalid_whatsapp'
  | 'merchant_not_found'
  | 'update_failed'
  | 'audit_failed';

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function normalizeWhatsapp(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }

  return `+${toWhatsAppLink(raw).replace('https://wa.me/', '')}`;
}

async function getMerchantAccountForUser(userId: string): Promise<MerchantAccount | null> {
  const admin = createSupabaseAdminClient();
  const { data: member, error: memberError } = await admin
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (memberError) {
    throw memberError;
  }

  if (!member) {
    return null;
  }

  const { data: account, error: accountError } = await admin
    .from('merchant_account')
    .select('*')
    .eq('id', member.merchant_account_id)
    .is('deleted_at', null)
    .maybeSingle();

  if (accountError) {
    throw accountError;
  }

  return account;
}

export async function getMerchantAccount(): Promise<MerchantAccount | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  return getMerchantAccountForUser(user.id);
}

async function writeAuditLog(
  account: MerchantAccount,
  actorUserId: string,
  action: 'merchant.onboarded' | 'merchant.profile_updated',
) {
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from('audit_log').insert({
    merchant_account_id: account.id,
    actor_user_id: actorUserId,
    action,
    resource_type: 'merchant_account',
    resource_id: account.id,
  });

  return error;
}

async function updateMerchantProfile({
  account,
  actorUserId,
  input,
  markOnboarded,
}: {
  account: MerchantAccount;
  actorUserId: string;
  input: MerchantProfileInput;
  markOnboarded: boolean;
}): Promise<{ ok: true } | { ok: false; errorCode: MerchantActionErrorCode }> {
  const whatsapp = input.whatsapp?.trim();

  if (whatsapp && !isValidPhoneSN(whatsapp)) {
    return { ok: false, errorCode: 'invalid_whatsapp' };
  }

  const admin = createSupabaseAdminClient();
  const { error: updateError } = await admin
    .from('merchant_account')
    .update({
      name: input.shopName,
      country_code: input.countryCode,
      owner_full_name: input.ownerFullName,
      whatsapp_e164: normalizeWhatsapp(whatsapp),
      ...(markOnboarded ? { onboarded_at: new Date().toISOString() } : {}),
    })
    .eq('id', account.id);

  if (updateError) {
    return { ok: false, errorCode: 'update_failed' };
  }

  const auditError = await writeAuditLog(
    account,
    actorUserId,
    markOnboarded ? 'merchant.onboarded' : 'merchant.profile_updated',
  );

  if (auditError) {
    return { ok: false, errorCode: 'audit_failed' };
  }

  return { ok: true };
}

export const completeOnboardingAction = authActionClient
  .metadata({ actionName: 'merchant.complete_onboarding', section: 'merchant' })
  .inputSchema(merchantProfileSchema)
  .action(async ({ ctx, parsedInput }) => {
    const account = await getMerchantAccountForUser(ctx.user.id);

    if (!account) {
      return { ok: false as const, errorCode: 'merchant_not_found' as const };
    }

    return updateMerchantProfile({
      account,
      actorUserId: ctx.user.id,
      input: parsedInput,
      markOnboarded: true,
    });
  });

export const updateMerchantProfileAction = authActionClient
  .metadata({ actionName: 'merchant.update_profile', section: 'merchant' })
  .inputSchema(merchantProfileSchema)
  .action(async ({ ctx, parsedInput }) => {
    const account = await getMerchantAccountForUser(ctx.user.id);

    if (!account) {
      return { ok: false as const, errorCode: 'merchant_not_found' as const };
    }

    return updateMerchantProfile({
      account,
      actorUserId: ctx.user.id,
      input: parsedInput,
      markOnboarded: false,
    });
  });
