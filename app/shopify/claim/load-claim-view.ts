// SHOPIFY-OAUTH-FIRST-01 / B3 — lectures de la page GET /shopify/claim (aucune écriture).
//
// Module `.ts` distinct de la page : c'est ici que vit le client service-role, pour qu'il reste
// visible de l'inventaire (scripts/s4-check-service-role-inventory.mjs ne lit que les `*.ts`).
// Ce client ne sert qu'à `read_shopify_pending_installation` (0160, réservée à `service_role`,
// STABLE, ne rend que le domaine, l'app et un état). Session, appartenance et nom de l'espace
// passent par le client de session, sous RLS.
import { SHOPIFY_CLAIM_TICKET_COOKIE } from '@/lib/shopify/claim-ticket';
import {
  type ShopifyClaimView,
  loadShopifyClaimView,
  readShopifyPendingInstallation,
} from '@/lib/shopify/claim-view';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { cookies } from 'next/headers';

function createSupabaseAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return createProtectedSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function loadShopifyClaimPageView(): Promise<ShopifyClaimView> {
  const ticket = (await cookies()).get(SHOPIFY_CLAIM_TICKET_COOKIE)?.value;
  const admin = createSupabaseAdminClient();
  const supabase = await createSupabaseServerClient();

  return loadShopifyClaimView({
    readPending: async () =>
      admin ? readShopifyPendingInstallation(admin, ticket) : { state: 'error' },
    getUserId: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return user?.id ?? null;
    },
    getMembership: async (userId) => {
      // Même lecture que `requireRole` (lib/actions/safe-action.ts), que le POST refait.
      const { data, error } = await supabase
        .from('merchant_member')
        .select('merchant_account_id, role')
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();
      if (error) return 'error';
      const member = data as { merchant_account_id: string; role: string } | null;
      return member ? { merchantAccountId: member.merchant_account_id, role: member.role } : null;
    },
    getAccountName: async (merchantAccountId) => {
      const { data } = await supabase
        .from('merchant_account')
        .select('name')
        .eq('id', merchantAccountId)
        .maybeSingle();
      return (data as { name: string } | null)?.name ?? null;
    },
  });
}
