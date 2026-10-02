// SHOPIFY-OAUTH-FIRST-01 / B3 — GET /shopify/claim : décision de la page, en LECTURE SEULE.
//
// Aucune écriture, quel que soit le cas (T15) : ni le ticket, ni l'attente, ni le bail, ni un
// audit ne changent ici. Le rattachement ne part que du POST explicite (B4).
//
// Ordre :
//   1. ticket (cookie) → `read_shopify_pending_installation` : inconnu, consommé ou expiré →
//      message de reprise, sans session requise ;
//   2. session : absente → connexion, avec `/shopify/claim` pour seule reprise ;
//   3. appartenance : aucune → onboarding, reprise préservée (D5) ;
//   4. rôle : ni owner ni manager → refus nommé, sans bouton (D4 ; le POST le revérifie) ;
//   5. confirmation : domaine myshopify en évidence et nom de l'espace.
//
// Pur : les lectures sont injectées (page réelle et tests), aucune dépendance d'environnement.
import { SHOPIFY_CLAIM_PATH, hashShopifyClaimTicket } from '@/lib/shopify/claim-ticket';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

export type PendingInstallationRead =
  | { state: 'valid'; shopDomain: string; clientId: string }
  | { state: 'invalid' }
  | { state: 'error' };

// Lecture seule d'une attente par l'empreinte du ticket. Un ticket de forme invalide n'atteint
// pas la base.
export async function readShopifyPendingInstallation(
  admin: AdminClient,
  ticket: string | null | undefined,
): Promise<PendingInstallationRead> {
  const ticketHash = hashShopifyClaimTicket(ticket);
  if (!ticketHash) {
    return { state: 'invalid' };
  }

  const { data, error } = await admin.rpc('read_shopify_pending_installation', {
    p_ticket_hash: ticketHash,
  });
  if (error) {
    return { state: 'error' };
  }

  const row = data?.[0];
  if (row?.state === 'valid' && row.shop_domain && row.shopify_client_id) {
    return { state: 'valid', shopDomain: row.shop_domain, clientId: row.shopify_client_id };
  }
  return { state: 'invalid' };
}

export const SHOPIFY_CLAIM_LOGIN_PATH = `/connexion?redirectTo=${encodeURIComponent(SHOPIFY_CLAIM_PATH)}`;
export const SHOPIFY_CLAIM_ONBOARDING_PATH = `/onboarding?redirectTo=${encodeURIComponent(SHOPIFY_CLAIM_PATH)}`;

export type ShopifyClaimView =
  | { kind: 'ticket_invalid' }
  | { kind: 'error' }
  | { kind: 'redirect'; to: string }
  | { kind: 'forbidden' }
  | { kind: 'confirm'; shopDomain: string; accountName: string };

export type ShopifyClaimViewDeps = {
  readPending: () => Promise<PendingInstallationRead>;
  getUserId: () => Promise<string | null>;
  getMembership: (
    userId: string,
  ) => Promise<{ merchantAccountId: string; role: string } | null | 'error'>;
  getAccountName: (merchantAccountId: string) => Promise<string | null>;
};

export async function loadShopifyClaimView(deps: ShopifyClaimViewDeps): Promise<ShopifyClaimView> {
  const pending = await deps.readPending();
  if (pending.state === 'error') {
    return { kind: 'error' };
  }
  if (pending.state === 'invalid') {
    return { kind: 'ticket_invalid' };
  }

  const userId = await deps.getUserId();
  if (!userId) {
    return { kind: 'redirect', to: SHOPIFY_CLAIM_LOGIN_PATH };
  }

  const membership = await deps.getMembership(userId);
  if (membership === 'error') {
    return { kind: 'error' };
  }
  if (!membership) {
    return { kind: 'redirect', to: SHOPIFY_CLAIM_ONBOARDING_PATH };
  }
  if (membership.role !== 'owner' && membership.role !== 'manager') {
    return { kind: 'forbidden' };
  }

  const accountName = await deps.getAccountName(membership.merchantAccountId);
  return {
    kind: 'confirm',
    shopDomain: pending.shopDomain,
    accountName: accountName ?? '',
  };
}
