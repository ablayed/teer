// SHOPIFY-OAUTH-FIRST-01 / B4 — POST de rattachement d'une installation en attente.
//
// Appelé par l'action serveur (lib/actions/shopify-claim.ts) APRÈS `requireRole('owner',
// 'manager')`. L'utilisateur et l'espace viennent de la SESSION ; le navigateur ne fournit que le
// ticket, par son cookie. La base revérifie le rôle (D4) sous verrou.
//
//   1. ticket → attente (lecture) : le domaine sert à prendre le bail ;
//   2. bail du domaine ;
//   3. `consume_shopify_pending_installation`, UNE transaction : propriété, app, attente périmée
//      (D22), persistance fencée, audit `shopify.connected`, ticket consommé ;
//   4. selon le verdict :
//        inserted / updated   store_connection sous le bail, libération, abonnements webhook,
//                             synchronisation (R2) ;
//        already_connected    libération, arrivée (D22) ;
//        refused              libération, audit `shopify.claim_refused` chez le DEMANDEUR (D6) ;
//        ticket_invalid, forbidden, lease_lost : libération éventuelle, refus nommé.
// R3 : seul le bail acquis ici est libéré, avec sa génération ; aucun après `lease_lost`.
//
// Module pur de toute dépendance d'environnement : importable par les suites RLS.
import { hashShopifyClaimTicket } from '@/lib/shopify/claim-ticket';
import { readShopifyPendingInstallation } from '@/lib/shopify/claim-view';
import {
  type PostConnectApp,
  reconcileWebhooksAfterConnect,
  reportPostConnectEffectFailed,
  syncProductsAfterConnect,
  writeStoreConnectionUnderLease,
} from '@/lib/shopify/post-connect-effects';
import type { ShopifyPublicErrorCode } from '@/lib/shopify/public-error';
import {
  acquireShopifyTokenLease,
  releaseShopifyTokenLease,
  reportShopifyTokenLeaseBusy,
  reportShopifyTokenLeaseLost,
} from '@/lib/shopify/token-lease';
import type { Database } from '@/lib/supabase/database.types';
import * as Sentry from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

export type ShopifyClaimOutcome =
  | { kind: 'connected'; syncPending: boolean }
  | { kind: 'already_connected' }
  | { kind: 'error'; code: ShopifyPublicErrorCode };

export type ShopifyClaimInput = {
  ticket: string | null | undefined;
  userId: string;
  merchantAccountId: string;
  // Registre des apps, injecté : ce module ne lit pas l'environnement.
  resolveApp: (clientId: string) => PostConnectApp | null;
};

export type ShopifyClaimDeps = {
  syncProducts: typeof syncProductsAfterConnect;
  reconcileWebhooks: typeof reconcileWebhooksAfterConnect;
};

const defaultDeps: ShopifyClaimDeps = {
  syncProducts: syncProductsAfterConnect,
  reconcileWebhooks: reconcileWebhooksAfterConnect,
};

// Un seul verdict retient le ticket : un bail tenu ou repris est une collision passagère, et le
// même ticket reste valable pour réessayer. Tout autre verdict est terminal.
export function isTerminalClaimOutcome(outcome: ShopifyClaimOutcome): boolean {
  return !(outcome.kind === 'error' && outcome.code === 'connection_in_progress');
}

function reportClaimFailure(reason: string): void {
  Sentry.captureMessage('shopify_claim_failed', {
    level: 'warning',
    tags: { module: 'shopify.claim', reason },
  });
}

async function writeClaimRefusedAudit(
  admin: AdminClient,
  input: { userId: string; merchantAccountId: string },
): Promise<void> {
  // D6 — dans le locataire DEMANDEUR, acteur = l'utilisateur. Rien chez le propriétaire, et
  // aucune donnée qui le désignerait (ni domaine, ni identifiant de boutique).
  const { error } = await admin.from('audit_log').insert({
    merchant_account_id: input.merchantAccountId,
    actor_user_id: input.userId,
    action: 'shopify.claim_refused',
    resource_type: 'shop',
    resource_id: null,
  });
  if (error) {
    reportClaimFailure('claim_refused_audit_failed');
  }
}

export async function performShopifyClaim(
  admin: AdminClient,
  input: ShopifyClaimInput,
  deps: ShopifyClaimDeps = defaultDeps,
): Promise<ShopifyClaimOutcome> {
  const ticketHash = hashShopifyClaimTicket(input.ticket);
  if (!ticketHash) {
    return { kind: 'error', code: 'ticket_invalid' };
  }

  // (1) Domaine de l'attente, pour prendre le bail AVANT la transaction (règle de 0159).
  const pending = await readShopifyPendingInstallation(admin, input.ticket);
  if (pending.state === 'error') {
    reportClaimFailure('pending_read_failed');
    return { kind: 'error', code: 'unknown' };
  }
  if (pending.state === 'invalid') {
    return { kind: 'error', code: 'ticket_invalid' };
  }

  // (2) Bail.
  const lease = await acquireShopifyTokenLease(admin, pending.shopDomain);
  if (!lease.ok) {
    if (lease.reason === 'lease_held') {
      reportShopifyTokenLeaseBusy('authorization_code');
      return { kind: 'error', code: 'connection_in_progress' };
    }
    return { kind: 'error', code: 'unknown' };
  }

  let leaseHeld = true;
  let connected: { shopId: string; app: PostConnectApp | null; syncPending: boolean } | null = null;
  let refused = false;

  try {
    // (3) Consommation.
    const { data, error } = await admin.rpc('consume_shopify_pending_installation', {
      p_ticket_hash: ticketHash,
      p_user_id: input.userId,
      p_merchant_account_id: input.merchantAccountId,
      p_generation: lease.generation,
    });
    if (error) {
      // Transaction annulée : le ticket n'est pas consommé (T18).
      reportClaimFailure('consume_rpc_failed');
      return { kind: 'error', code: 'unknown' };
    }

    const verdict = data?.[0];
    switch (verdict?.outcome) {
      case 'inserted':
      case 'updated': {
        if (!verdict.shop_id || !verdict.shop_domain || !verdict.shopify_client_id) {
          reportClaimFailure('consume_verdict_incomplete');
          return { kind: 'error', code: 'unknown' };
        }
        // (4) Persistance faite : c'est un rattachement réussi (R2). store_connection sous le bail.
        const app = input.resolveApp(verdict.shopify_client_id);
        let connectionWritten = false;
        if (app) {
          connectionWritten = await writeStoreConnectionUnderLease(admin, {
            shopDomain: verdict.shop_domain,
            generation: lease.generation,
            merchantAccountId: input.merchantAccountId,
            clientId: verdict.shopify_client_id,
          });
        } else {
          reportPostConnectEffectFailed('store_connection', 'app_unknown');
        }
        connected = { shopId: verdict.shop_id, app, syncPending: !connectionWritten };
        break;
      }
      case 'already_connected':
        return { kind: 'already_connected' };
      case 'refused':
        refused = true;
        break;
      case 'ticket_invalid':
        return { kind: 'error', code: 'ticket_invalid' };
      case 'forbidden':
        return { kind: 'error', code: 'forbidden' };
      case 'lease_lost':
        // Le bail a été repris : il n'est plus à nous, aucune libération (R3).
        leaseHeld = false;
        reportShopifyTokenLeaseLost('authorization_code');
        return { kind: 'error', code: 'connection_in_progress' };
      default:
        reportClaimFailure(`verdict_${verdict?.outcome ?? 'missing'}`);
        return { kind: 'error', code: 'unknown' };
    }
  } finally {
    if (leaseHeld) {
      await releaseShopifyTokenLease(admin, pending.shopDomain, lease.generation);
    }
  }

  if (refused) {
    await writeClaimRefusedAudit(admin, input);
    return { kind: 'error', code: 'refused' };
  }

  if (!connected) {
    return { kind: 'error', code: 'unknown' };
  }

  // Bail des jetons libéré : abonnements webhook (E1), puis synchronisation des produits. Chacun
  // au moins une fois (R2) : un échec n'est qu'observé, le rattachement reste acquis.
  const webhooksReconciled = connected.app
    ? await deps.reconcileWebhooks(admin, { shopId: connected.shopId, app: connected.app })
    : false;
  const synced = connected.app
    ? await deps.syncProducts(admin, {
        shopId: connected.shopId,
        app: connected.app,
        actorUserId: input.userId,
      })
    : false;
  return {
    kind: 'connected',
    syncPending: connected.syncPending || !webhooksReconciled || !synced,
  };
}
