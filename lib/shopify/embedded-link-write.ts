// APP-03 / Lot 2 — cœur métier du rattachement Teer Public embarqué, isolé de next-safe-action
// (pas de 'use server', pas de dépendance à `ctx` du safe-action client) pour rester
// unitairement testable en appelant la fonction directement, comme
// `performTransitionForContext` (lib/actions/transitions.ts) sépare déjà orchestration et wrapper.
//
// Écrit uniquement sur appel explicite (jamais sur GET — l'appelant, une server action `'use
// server'`, est lui-même déclenché par un POST de formulaire). Trois gardes distinctes, dans cet
// ordre : (1) rôle marchand autoritatif — owner/manager uniquement, lu explicitement et jamais
// supposé, et réévalué par la RPC d'écriture (SEC-SHOP-CLAIM-01, 0155 : `authenticated` n'a
// plus aucun privilège INSERT/UPDATE sur `shop`, l'écriture passe par
// `link_shopify_embedded_shop`, réservée à `service_role`) ; (2) bascule d'app — une boutique
// déjà possédée par une autre app est refusée MÊME pour le même tenant
// (lib/shopify/app-switch-guard.ts) ; (3) propriété par tenant —
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

// Refus nommés rendus par `link_shopify_embedded_shop` (0155) — la RPC réévalue sous verrou les
// gardes déjà appliquées ci-dessous ; un refus à ce stade signale une course ou une garde que la
// RLS portait implicitement (rôle de boutique). Toute autre valeur est un échec fermé.
const LINK_REFUSALS = new Map<
  string,
  Extract<ShopifyEmbeddedLinkResult, { ok: false }>['errorCode']
>([
  ['intent_invalid', 'intent_invalid'],
  ['not_a_member', 'not_a_member'],
  ['insufficient_role', 'insufficient_role'],
  ['app_switch_refused', 'app_switch_refused'],
  ['ownership_refused', 'ownership_refused'],
]);

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
  // qu'un chemin l'écrit en service-role ; c'est le cas ici depuis 0155 (écriture par une RPC
  // réservée à `service_role`, voir plus bas) : la RPC réévalue ce rôle sous verrou, et cette
  // garde refuse avant tout appel — code d'échec nommé, distinct de 'not_a_member' (un agent
  // EST membre, mais n'a pas le rôle requis).
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

  // SEC-SHOP-CLAIM-01 (0155) — `authenticated` n'a plus AUCUN privilège INSERT/UPDATE sur
  // `shop` : un client utilisateur pouvait y préempter le domaine d'une boutique étrangère avec le
  // client_id de l'app publique, et la route de session écrivait ensuite le jeton de la victime
  // dans cette ligne. L'écriture passe donc par une primitive réservée à `service_role`,
  // `link_shopify_embedded_shop`, qui réévalue sous verrou, à partir de `ctx.userId` (session
  // serveur) et de l'intention vérifiée, tout ce que la RLS portait implicitement : rôle marchand
  // au moment de l'écriture, rôle de boutique sur une ligne existante, bascule d'app, propriété.
  // Les gardes TS ci-dessus restent en place (défense en profondeur, refus nommés avant l'appel) ;
  // le client utilisateur ne sert plus qu'à la lecture d'appartenance.
  const { data: linkResult, error: linkError } = await admin.rpc('link_shopify_embedded_shop', {
    p_user_id: ctx.userId,
    p_merchant_account_id: input.merchantAccountId,
    p_shop_domain: intent.shopDomain,
    p_client_id: app.clientId,
  });

  if (linkError || (linkResult !== 'inserted' && linkResult !== 'updated')) {
    const refusal = linkError ? null : LINK_REFUSALS.get(linkResult ?? '');
    if (refusal) {
      return { ok: false, errorCode: refusal };
    }
    Sentry.captureException(linkError ?? new Error('shopify_embedded_link_rpc_failed'), {
      tags: { action: 'shopify.embedded_link', reason: 'shop_link_rpc_failed' },
    });
    return { ok: false, errorCode: 'write_failed' };
  }

  const redirectUrl = buildShopifyEmbeddedAppUrl(intent.host, app.clientId);
  if (!redirectUrl) {
    return { ok: false, errorCode: 'destination_unavailable' };
  }

  return { ok: true, redirectUrl };
}
