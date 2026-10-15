// Droit d'un membre sur UNE boutique, établi par sa SESSION.
//
// Les lectures du catalogue passent par le client service-role (le coût d'achat est masqué à
// l'agent par la RLS, la lecture se fait donc hors RLS). Un client service-role ne sait pas quelle
// boutique le membre a le droit de voir : l'identifiant de boutique reçu en argument ne doit
// JAMAIS suffire. Il est confronté ici à `get_my_store`, qui s'exécute sous la session du membre
// et ne rend la boutique que s'il y a une appartenance (`shop_member`). Le compte de la boutique
// doit en outre être celui du membre.
//
// Pas de `'use server'` : ce module n'expose aucune action. Aucun client service-role ici.
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const shopIdSchema = z.string().uuid();

export type MemberShopAccess =
  | { ok: true; merchantAccountId: string; shopRole: string }
  | { ok: false; errorCode: 'forbidden' | 'load_failed' };

export async function resolveMemberShopAccess(
  sessionClient: SupabaseClient<Database>,
  shopId: string,
  memberMerchantAccountId: string,
): Promise<MemberShopAccess> {
  // Un identifiant qui n'en est pas un n'est pas une boutique : refus, sans interroger la base.
  if (!shopIdSchema.safeParse(shopId).success) {
    return { ok: false, errorCode: 'forbidden' };
  }

  const { data, error } = await sessionClient.rpc('get_my_store', { p_shop_id: shopId });
  // Une lecture en échec n'est ni un refus ni un accès : elle se dit (règle 15).
  if (error) return { ok: false, errorCode: 'load_failed' };

  const store = data?.[0];
  if (!store || store.merchant_account_id !== memberMerchantAccountId) {
    return { ok: false, errorCode: 'forbidden' };
  }

  return { ok: true, merchantAccountId: store.merchant_account_id, shopRole: store.role };
}

// Règle commune de l'accès aux coûts : le rôle du COMPTE et le rôle dans la BOUTIQUE doivent tous
// deux être owner ou manager. Elle ne peut qu'enlever un accès, jamais en ouvrir un. Lecture,
// pagination et écriture de coût l'appliquent toutes : on ne modifie pas un coût qu'on ne peut pas lire.
const COST_ROLES = new Set(['owner', 'manager']);

export function canSeeCostsInShop(accountRole: string, shopRole: string): boolean {
  return COST_ROLES.has(accountRole) && COST_ROLES.has(shopRole);
}
