'use server';

// SHOPIFY-OAUTH-FIRST-01 / B4 — action serveur de rattachement (POST de /shopify/claim).
//
// Traitée comme DIRECTEMENT ACCESSIBLE : Next compare `Origin` à l'hôte, mais admet une requête
// SANS `Origin` (simple avertissement). Aucune de ses protections ne repose donc sur ce contrôle :
//   - `requireRole('owner', 'manager')` refait l'authentification et le rôle à chaque appel ;
//   - utilisateur et espace viennent de la session, jamais du client ; l'entrée est vide ;
//   - le ticket n'arrive QUE par son cookie `httpOnly`, `SameSite=Lax`, limité à /shopify/claim,
//     absent d'un POST intersite réel ; absent ou inconnu → `ticket_invalid` ;
//   - la base revérifie le rôle sous verrou (`consume_shopify_pending_installation`, D4).
// Le client service-role n'appelle que les primitives de 0160 et l'écriture de l'audit de refus
// (supabase/security/service-role-inventory.json).
import { requireRole } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { getShopifyAppByClientId } from '@/lib/shopify/apps';
import { shopifyArrivalPath } from '@/lib/shopify/arrival';
import { isTerminalClaimOutcome, performShopifyClaim } from '@/lib/shopify/claim-core';
import { SHOPIFY_CLAIM_PATH, SHOPIFY_CLAIM_TICKET_COOKIE } from '@/lib/shopify/claim-ticket';
import { shopifyPublicErrorPath } from '@/lib/shopify/public-error';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

function createSupabaseAdminClient() {
  return createProtectedSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

export const claimShopifyInstallationAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'shopify.claim_installation', section: 'shops' })
  .inputSchema(z.object({}))
  .action(async ({ ctx }) => {
    const cookieStore = await cookies();
    const outcome = await performShopifyClaim(createSupabaseAdminClient(), {
      ticket: cookieStore.get(SHOPIFY_CLAIM_TICKET_COOKIE)?.value,
      userId: ctx.user.id,
      merchantAccountId: ctx.member.merchantAccountId,
      resolveApp: (clientId) => getShopifyAppByClientId(clientId),
    });

    if (isTerminalClaimOutcome(outcome)) {
      cookieStore.delete({ name: SHOPIFY_CLAIM_TICKET_COOKIE, path: SHOPIFY_CLAIM_PATH });
    }

    if (outcome.kind === 'connected') {
      redirect(
        shopifyArrivalPath({ hasSession: true, connected: true, syncPending: outcome.syncPending }),
      );
    }
    if (outcome.kind === 'already_connected') {
      redirect(shopifyArrivalPath({ hasSession: true, syncPending: false }));
    }
    if (outcome.code === 'connection_in_progress') {
      // Le ticket reste valable : l'écran propose de réessayer.
      return { ok: false as const, errorCode: 'connection_in_progress' as const };
    }
    redirect(shopifyPublicErrorPath(outcome.code));
  });
