// SHOPIFY-OAUTH-FIRST-01 / B8 — purge des installations Shopify en attente, branchée sur le cron
// existant `shopify-pcd-retention` (aucun cron ajouté).
//
// `purge_expired_shopify_pending_installations` (0160) supprime les attentes actives expirées
// (elles portent encore des credentials chiffrés) et les attentes consommées depuis plus de sept
// jours (elles n'en portent plus). Seul le COMPTE est journalisé : ni domaine, ni empreinte de
// ticket. La purge locale ne révoque rien côté Shopify.
//
// Module pur de toute dépendance d'environnement.
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function purgeExpiredShopifyPendingInstallations(
  admin: SupabaseClient<Database>,
): Promise<number | null> {
  const { data, error } = await admin.rpc('purge_expired_shopify_pending_installations');
  if (error) {
    // biome-ignore lint/suspicious/noConsole: journal opérationnel du cron (code d'erreur seul).
    console.error('[shopify-pcd-retention] pending installations purge failed', {
      code: error.code,
    });
    return null;
  }
  const count = typeof data === 'number' ? data : 0;
  // biome-ignore lint/suspicious/noConsole: journal opérationnel du cron (compte seul).
  console.log('[shopify-pcd-retention] pending installations purged', { count });
  return count;
}
