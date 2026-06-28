import { expect } from '@playwright/test';
import {
  type AdminClient,
  createConfirmedUser,
  e2eEmail,
  e2ePassword,
  waitForMerchant,
} from './auth';

export async function createUnboardedTestUser(
  admin: AdminClient,
): Promise<{ email: string; password: string; userId: string; merchantAccountId: string }> {
  const email = e2eEmail('onboarding');
  const userId = await createConfirmedUser(admin, email);
  const merchantAccountId = await waitForMerchant(admin, userId);

  const { error } = await admin
    .from('merchant_account')
    .update({
      name: `Teer E2E Onboarding ${Date.now()}`,
      onboarded_at: null,
      owner_full_name: null,
      whatsapp_e164: null,
    })
    .eq('id', merchantAccountId);

  if (error) {
    throw error;
  }

  await expect
    .poll(
      async () => {
        const { data, error: merchantError } = await admin
          .from('merchant_account')
          .select('onboarded_at')
          .eq('id', merchantAccountId)
          .limit(1)
          .maybeSingle();

        if (merchantError) {
          throw merchantError;
        }

        return data?.onboarded_at ?? null;
      },
      { timeout: 10_000, intervals: [150, 300, 500] },
    )
    .toBeNull();

  return { email, password: e2ePassword, userId, merchantAccountId };
}
