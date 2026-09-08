// APP-03 / Lot 2 — cœur métier du rattachement Teer Public embarqué, isolé de next-safe-action
// (pas de 'use server', pas de dépendance à `ctx` du safe-action client) pour rester
// unitairement testable en appelant la fonction directement, comme
// `performTransitionForContext` (lib/actions/transitions.ts) sépare déjà orchestration et wrapper.
//
// Écrit uniquement sur appel explicite (jamais sur GET — l'appelant, une server action `'use
// server'`, est lui-même déclenché par un POST de formulaire). Trois gardes distinctes, dans cet
// ordre : (1) rôle marchand autoritatif — owner/manager uniquement, lu explicitement et jamais
// supposé (la garde applicative doit reproduire la règle RLS `shop_insert`/`shop_update`, pas la
// tenir pour acquise, puisque l'écriture elle-même passe par un client authentifié où cette règle
// s'applique déjà, mais où une régression future de l'un des deux côtés ne doit pas être le seul
// filet) ; (2) bascule d'app — une boutique déjà possédée par une autre app est refusée MÊME pour
// le même tenant (lib/shopify/app-switch-guard.ts) ; (3) propriété par tenant —
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

const WRITE_ROLES = new Set(['owner', 'manager']);

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
        | 'insufficient_role'
        | 'app_switch_refused'
        | 'ownership_refused'
        | 'write_failed'
        | 'destination_unavailable';
    };

export async function performShopifyEmbeddedLink(
  input: ShopifyEmbeddedLinkInput,
  ctx: ShopifyEmbeddedLinkContext,
): Promise<ShopifyEmbeddedLinkResult> {
  // Cast TS uniquement, appliqué une fois : `createServerClient` (@supabase/ssr) et `createClient`
  // (@supabase/supabase-js) exposent des signatures génériques incompatibles pour le MÊME type
  // `Database` sur `.select()` à plusieurs colonnes / `.insert()` / `.update()` (friction connue
  // entre les deux paquets) — objet runtime identique à `ctx.supabase`, aucune conséquence sur
  // l'application RLS (déterminée par le JWT porté par le client, jamais par son typage TS).
  const rlsClient = ctx.supabase as unknown as ReturnType<typeof createSupabaseAdminClient>;

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

  const { data: membership, error: membershipError } = await rlsClient
    .from('merchant_member')
    .select('id, role')
    .eq('user_id', ctx.userId)
    .eq('merchant_account_id', input.merchantAccountId)
    .maybeSingle();

  if (membershipError || !membership) {
    return { ok: false, errorCode: 'not_a_member' };
  }

  // Rôle autoritatif lu explicitement, jamais supposé — motif récurrent du projet : une règle
  // portée par RLS (shop_insert/shop_update, owner/manager uniquement) devient inopérante dès
  // qu'un chemin l'écrit en service-role ; ici l'écriture passe par ctx.supabase (RLS-respecting,
  // voir plus bas) donc RLS l'applique déjà, mais cette garde reproduit la règle plutôt que de
  // dépendre uniquement de RLS pour la faire respecter — code d'échec nommé, distinct de
  // 'not_a_member' (un agent EST membre, mais n'a pas le rôle requis).
  if (!WRITE_ROLES.has(membership.role)) {
    return { ok: false, errorCode: 'insufficient_role' };
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

  // L'écriture passe par `ctx.supabase` (RLS-respecting), jamais `admin` — seule la lecture
  // globale ci-dessus (détecter une boutique d'un autre tenant, invisible sous RLS) a besoin du
  // service-role. shop_insert/shop_update (owner/manager) deviennent une seconde barrière
  // indépendante, en plus de la garde de rôle explicite ci-dessus et des deux gardes applicatives.
  //
  // Root cause identifiée (mesure définitive, deux inserts identiques comparés) : un `INSERT ...
  // RETURNING` échoue en 42501 tant qu'aucune ligne `shop_member` n'existe pour (shop, user) — la
  // visibilité RETURNING est vérifiée via la policy shop_select (`is_shop_member_of`), avant que
  // le trigger `shop_seed_memberships` (AFTER INSERT ON shop, déjà en place — migration 0126) ait
  // pu créer cette ligne. Un `.insert()` SANS `.select()` n'exerce jamais cette vérification et
  // réussit normalement, laissant le trigger peupler shop_member (avec le rôle exact du marchand,
  // via `merchant_member`) dans la même transaction — jamais une boutique orpheline invisible.
  // L'UPDATE (reconnexion) n'a pas ce problème : shop_member existe déjà depuis la création
  // initiale de la boutique, donc `.select()` y reste sûr.
  if (ownershipDecision.kind === 'insert') {
    const { error: insertError } = await rlsClient.from('shop').insert({
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
    // garde et cette écriture — 0 ligne modifiée (course, ou refus RLS) est alors un échec fermé
    // (`.select().maybeSingle()` renvoie `null`), jamais un succès silencieux.
    let updateQuery = rlsClient
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
