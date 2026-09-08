// APP-03 / Lot 2 — cœur métier du rattachement Teer Public embarqué, isolé de next-safe-action
// (pas de 'use server', pas de dépendance à `ctx` du safe-action client) pour rester
// unitairement testable en appelant la fonction directement, comme
// `performTransitionForContext` (lib/actions/transitions.ts) sépare déjà orchestration et wrapper.
//
// Écrit uniquement sur appel explicite (jamais sur GET — l'appelant, une server action `'use
// server'`, est lui-même déclenché par un POST de formulaire). Deux gardes distinctes, dans cet
// ordre : (1) bascule d'app — une boutique déjà possédée par une autre app est refusée MÊME pour
// le même tenant (lib/shopify/app-switch-guard.ts, nouveau) ; (2) propriété par tenant —
// `decideShopOwnership` (lib/shopify/ownership-guard.ts, APP-03/Lot 1), réutilisée telle quelle,
// jamais une seconde garde de tenant. `store_connection` n'est PAS créée ici — seule `shop` porte
// l'association en attente (`access_token_encrypted` reste NULL) ; `store_connection` devient
// active après le token exchange (app/api/shopify/embedded/session/route.ts).
import {
  ShopifyAppSwitchRefusedError,
  ShopifyPublicLegacyRouteRefusedError,
} from '@/lib/shopify/app-identity-errors';
import { decideShopAppSwitch } from '@/lib/shopify/app-switch-guard';
import { getShopifyAppByClientId } from '@/lib/shopify/apps';
import { buildShopifyEmbeddedAppUrl } from '@/lib/shopify/embedded-host';
import { verifyEmbeddedLinkIntent } from '@/lib/shopify/embedded-link-intent';
import { decideShopOwnership } from '@/lib/shopify/ownership-guard';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import type { createSupabaseServerClient } from '@/lib/supabase/server';
import * as Sentry from '@sentry/nextjs';

// `process.env` direct, jamais `lib/env.ts` (cf. app/api/shopify/embedded/session/route.ts) :
// reste unitairement testable sans environnement serveur complet.
function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required for the Shopify embedded link write`);
  }

  return value;
}

function createSupabaseAdminClient() {
  return createProtectedSupabaseClient(
    getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
    getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}

export type ShopifyEmbeddedLinkInput = {
  intent: string;
  merchantAccountId: string;
};

export type ShopifyEmbeddedLinkContext = {
  userId: string;
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
};

export type ShopifyEmbeddedLinkResult =
  | { ok: true; redirectUrl: string }
  | {
      ok: false;
      errorCode:
        | 'intent_invalid'
        | 'app_unknown'
        | 'not_a_member'
        | 'app_switch_refused'
        | 'ownership_refused'
        | 'write_failed'
        | 'destination_unavailable';
    };

export async function performShopifyEmbeddedLink(
  input: ShopifyEmbeddedLinkInput,
  ctx: ShopifyEmbeddedLinkContext,
): Promise<ShopifyEmbeddedLinkResult> {
  const intent = verifyEmbeddedLinkIntent(input.intent);
  if (!intent) {
    return { ok: false, errorCode: 'intent_invalid' };
  }

  const app = getShopifyAppByClientId(intent.clientId);
  if (!app) {
    return { ok: false, errorCode: 'app_unknown' };
  }

  // Teer Public n'a de valeur que sur ce chemin ; un state legacy ne peut structurellement pas
  // arriver ici (verifyEmbeddedLinkIntent le rejette déjà), mais on garde le garde-fou nommé.
  if (app.label !== 'teer-public') {
    Sentry.captureException(new ShopifyPublicLegacyRouteRefusedError(), {
      tags: { action: 'shopify.embedded_link', reason: 'unexpected_app_label' },
    });
    return { ok: false, errorCode: 'app_unknown' };
  }

  const { data: membership, error: membershipError } = await ctx.supabase
    .from('merchant_member')
    .select('id')
    .eq('user_id', ctx.userId)
    .eq('merchant_account_id', input.merchantAccountId)
    .maybeSingle();

  if (membershipError || !membership) {
    return { ok: false, errorCode: 'not_a_member' };
  }

  const admin = createSupabaseAdminClient();
  const { data: existingShop, error: existingShopError } = await admin
    .from('shop')
    .select('id, merchant_account_id, shopify_client_id')
    .eq('shop_domain', intent.shopDomain)
    .maybeSingle();

  if (existingShopError) {
    return { ok: false, errorCode: 'write_failed' };
  }

  const appSwitchDecision = decideShopAppSwitch(existingShop, app.clientId);
  if (appSwitchDecision.kind === 'refuse') {
    Sentry.captureException(new ShopifyAppSwitchRefusedError(), {
      tags: { action: 'shopify.embedded_link', reason: 'app_switch_refused' },
    });
    return { ok: false, errorCode: 'app_switch_refused' };
  }

  const ownershipDecision = decideShopOwnership(existingShop, input.merchantAccountId);
  if (ownershipDecision.kind === 'refuse') {
    Sentry.captureMessage('shopify_embedded_link_ownership_guard_refused', {
      level: 'warning',
      tags: { action: 'shopify.embedded_link', reason: 'ownership_mismatch' },
    });
    return { ok: false, errorCode: 'ownership_refused' };
  }

  const now = new Date().toISOString();

  // Écriture via `admin` (service-role) — PAS `ctx.supabase`. Un basculement vers le client
  // RLS-respecting a été tenté et abandonné : preuve reproductible que l'INSERT échoue sous
  // PostgREST (42501, "new row violates row-level security policy") pour un owner légitime, alors
  // que la MÊME vérification réussit en SQL direct et que la RPC current_member_role(), appelée
  // avec le même JWT, renvoie correctement 'owner' — écart net entre l'évaluation RLS au sein
  // d'un INSERT PostgREST et son équivalent SQL/RPC sur ce stack, cause non identifiée. Basculer
  // aurait cassé le rattachement pour TOUT utilisateur, y compris légitime — une régression,
  // jamais une seconde barrière. Reste défendu par les deux gardes applicatives ci-dessus
  // (bascule d'app, propriété par tenant) plus les prédicats de fermeture de course ci-dessous.
  if (ownershipDecision.kind === 'insert') {
    const { error: insertError } = await admin.from('shop').insert({
      merchant_account_id: input.merchantAccountId,
      shop_domain: intent.shopDomain,
      shopify_client_id: app.clientId,
      status: 'active',
      access_token_encrypted: null,
      display_name: intent.shopDomain,
    });

    if (insertError) {
      Sentry.captureException(insertError, {
        tags: { action: 'shopify.embedded_link', reason: 'shop_insert_failed' },
      });
      return { ok: false, errorCode: 'write_failed' };
    }
  } else {
    // update : jamais `merchant_account_id` dans le payload, seulement comme filtre WHERE —
    // même discipline que le callback OAuth legacy (APP-03 / Lot 1). Prédicat supplémentaire sur
    // `shopify_client_id` (la valeur lue par la garde de bascule d'app ci-dessus, `.is()` pour
    // NULL) : ferme la course où une autre requête réassignerait la boutique entre la lecture de
    // garde et cette écriture — 0 ligne modifiée (course) est alors un échec fermé (`.select().
    // maybeSingle()` renvoie `null`), jamais un succès silencieux.
    let updateQuery = admin
      .from('shop')
      .update({ shopify_client_id: app.clientId, status: 'active', updated_at: now })
      .eq('id', ownershipDecision.shopId)
      .eq('merchant_account_id', input.merchantAccountId);
    updateQuery =
      existingShop?.shopify_client_id === null
        ? updateQuery.is('shopify_client_id', null)
        : updateQuery.eq('shopify_client_id', existingShop?.shopify_client_id ?? app.clientId);

    const { data: updatedShop, error: updateError } = await updateQuery.select('id').maybeSingle();

    if (updateError || !updatedShop) {
      Sentry.captureException(updateError ?? new Error('shopify_embedded_link_update_no_row'), {
        tags: { action: 'shopify.embedded_link', reason: 'shop_update_failed' },
      });
      return { ok: false, errorCode: 'write_failed' };
    }
  }

  const redirectUrl = buildShopifyEmbeddedAppUrl(intent.host, app.clientId);
  if (!redirectUrl) {
    return { ok: false, errorCode: 'destination_unavailable' };
  }

  return { ok: true, redirectUrl };
}
