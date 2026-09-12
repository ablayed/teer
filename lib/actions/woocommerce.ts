'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { resolveShopContext } from '@/lib/ingestion/resolve-shop-context';
import type { Database } from '@/lib/supabase/database.types';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import { provisionWooCommerceSubscriptions } from '@/lib/woocommerce/subscriptions';
import { synchronizeWooCommerceOrders } from '@/lib/woocommerce/sync';
import { normalizeWooCommerceIdentity } from '@/lib/woocommerce/url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

const intentLifetimeMs = 10 * 60 * 1000;

const createIntentSchema = z.object({
  shopId: z.string().uuid().optional(),
  shopUrl: z.string().trim().min(1).max(2048),
});

function createSupabaseAdminClient() {
  return createProtectedSupabaseClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function secureCallbackUrl(): URL | null {
  try {
    const url = new URL('/api/woocommerce/callback', env.NEXT_PUBLIC_APP_URL);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function buildWooCommerceAuthorizeUrl(
  identity: string,
  intentId: string,
  callbackUrl: URL,
): string {
  const url = new URL('wc-auth/v1/authorize', `${identity.replace(/\/+$/, '')}/`);
  url.searchParams.set('app_name', 'Tëër');
  url.searchParams.set('scope', 'read_write');
  url.searchParams.set('user_id', intentId);
  url.searchParams.set('return_url', new URL('/parametres', env.NEXT_PUBLIC_APP_URL).toString());
  url.searchParams.set('callback_url', callbackUrl.toString());
  return url.toString();
}

export const createWooCommerceConnectionIntentAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'woocommerce.connection_intent.create', section: 'shops' })
  .inputSchema(createIntentSchema)
  .action(async ({ ctx, parsedInput }) => {
    let externalIdentifier: string;
    try {
      externalIdentifier = normalizeWooCommerceIdentity(parsedInput.shopUrl);
    } catch {
      return { ok: false as const, errorCode: 'invalid_shop_url' as const };
    }

    const userClient = ctx.supabase as unknown as SupabaseClient<Database>;
    const admin = createSupabaseAdminClient();
    const { data: wooConnections, error: connectionError } = await admin
      .from('store_connection')
      .select('id, shop_id, external_identifier')
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .eq('platform', 'woocommerce');
    if (connectionError) {
      return { ok: false as const, errorCode: 'connection_lookup_failed' as const };
    }

    const existingConnection = parsedInput.shopId
      ? wooConnections?.find((connection) => connection.shop_id === parsedInput.shopId)
      : null;
    if (existingConnection && existingConnection.external_identifier !== externalIdentifier) {
      return { ok: false as const, errorCode: 'shop_url_change_requires_review' as const };
    }

    if (!parsedInput.shopId && wooConnections && wooConnections.length > 0) {
      return { ok: false as const, errorCode: 'existing_shop_required' as const };
    }

    let targetShopId: string | null = null;
    if (parsedInput.shopId) {
      // This resolution intentionally uses the authenticated user's client. It proves the caller's
      // shop scope before a service-role client is used for the service-role-only intent table.
      const resolved = await resolveShopContext(userClient, {
        merchantAccountId: ctx.member.merchantAccountId,
        shopId: parsedInput.shopId,
      });
      if (!resolved.ok) {
        return { ok: false as const, errorCode: 'shop_not_found' as const };
      }

      const { data: shop, error: shopError } = await userClient
        .from('shop')
        .select('store_kind')
        .eq('id', resolved.context.shopId)
        .eq('merchant_account_id', resolved.context.merchantAccountId)
        .maybeSingle();
      if (shopError || !shop || shop.store_kind !== 'woocommerce') {
        return { ok: false as const, errorCode: 'shop_not_woocommerce' as const };
      }
      targetShopId = resolved.context.shopId;
    }

    const callbackUrl = secureCallbackUrl();
    if (!callbackUrl) {
      return { ok: false as const, errorCode: 'callback_url_not_secure' as const };
    }

    const expiresAt = new Date(Date.now() + intentLifetimeMs).toISOString();
    const { data: intent, error: intentError } = await admin
      .from('store_connection_intent')
      .insert({
        merchant_account_id: ctx.member.merchantAccountId,
        shop_id: targetShopId,
        target_kind: targetShopId ? 'existing_shop' : 'new_shop',
        platform: 'woocommerce',
        external_identifier: externalIdentifier,
        created_by_member_id: ctx.member.id,
        expires_at: expiresAt,
      })
      .select('id, expires_at')
      .single();

    if (intentError || !intent) {
      return { ok: false as const, errorCode: 'intent_creation_failed' as const };
    }

    return {
      ok: true as const,
      authorizeUrl: buildWooCommerceAuthorizeUrl(externalIdentifier, intent.id, callbackUrl),
      expiresAt: intent.expires_at,
    };
  });

export type WooCommerceConnectionIntentResult = Awaited<
  ReturnType<typeof createWooCommerceConnectionIntentAction>
>;

export type WooCommerceShopOption = {
  readonly id: string;
  readonly displayName: string;
  readonly domain: string;
};

export type WooCommerceConnectionListItem = {
  readonly id: string;
  readonly shopId: string;
  readonly shopName: string;
  readonly shopDomain: string;
  readonly externalIdentifier: string;
  readonly status: string;
  readonly subscriptions: Readonly<Partial<Record<'order.created' | 'order.updated', string>>>;
  readonly syncStatus: string | null;
  readonly syncLastErrorCode: string | null;
  readonly syncLastPageObserved: number;
  readonly syncUpdatedAt: string | null;
};

export const listWooCommerceConnectionsAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'woocommerce.connections.list', section: 'shops' })
  .inputSchema(z.object({}))
  .action(async ({ ctx }) => {
    const admin = createSupabaseAdminClient();
    const { data: shops, error: shopsError } = await admin
      .from('shop')
      .select('id, display_name, shop_domain')
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .eq('store_kind', 'woocommerce')
      .order('display_name', { ascending: true });
    if (shopsError) return { ok: false as const, errorCode: 'list_failed' as const };

    // `store_connection` n'a PAS de colonne `updated_at` — contrairement à toutes ses tables
    // filles (`_credential`, `_sync_state`, `_webhook_subscription`), qui en ont une. Trier
    // dessus faisait répondre PostgREST 400/42703 avant tout filtre de locataire : l'action
    // renvoyait `list_failed` pour TOUS les comptes, et le composant rendait cette erreur comme
    // « Aucune boutique WooCommerce connectée ». `created_at` est la seule colonne temporelle de
    // cette table. L'ordre entre deux connexions de MÊME `created_at` n'est pas garanti : le tri
    // n'est pas strictement total, ce qui exigerait un second critère (`id`). Sans conséquence
    // ici — les deux cartes sont rendues dans les deux cas. À revoir si un jour l'ordre entre
    // ex æquo porte une décision.
    const { data: connections, error: connectionsError } = await admin
      .from('store_connection')
      .select('id, shop_id, external_identifier, status')
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .eq('platform', 'woocommerce')
      .order('created_at', { ascending: false });
    if (connectionsError) return { ok: false as const, errorCode: 'list_failed' as const };

    const connectionIds = (connections ?? []).map((connection) => connection.id);
    const subscriptionQuery =
      connectionIds.length === 0
        ? Promise.resolve({ data: [], error: null })
        : admin
            .from('store_connection_webhook_subscription')
            .select('store_connection_id, topic, status')
            .in('store_connection_id', connectionIds);
    const syncQuery =
      connectionIds.length === 0
        ? Promise.resolve({ data: [], error: null })
        : admin
            .from('store_connection_sync_state')
            .select('store_connection_id, status, last_error_code, last_page_observed, updated_at')
            .in('store_connection_id', connectionIds);
    const [
      { data: subscriptions, error: subscriptionsError },
      { data: syncStates, error: syncError },
    ] = await Promise.all([subscriptionQuery, syncQuery]);
    if (subscriptionsError || syncError) {
      return { ok: false as const, errorCode: 'list_failed' as const };
    }

    const shopById = new Map((shops ?? []).map((shop) => [shop.id, shop]));
    const subscriptionsByConnection = new Map<
      string,
      Partial<Record<'order.created' | 'order.updated', string>>
    >();
    for (const subscription of subscriptions ?? []) {
      if (subscription.topic !== 'order.created' && subscription.topic !== 'order.updated')
        continue;
      const current = subscriptionsByConnection.get(subscription.store_connection_id) ?? {};
      current[subscription.topic] = subscription.status;
      subscriptionsByConnection.set(subscription.store_connection_id, current);
    }
    const syncByConnection = new Map(
      (syncStates ?? []).map((state) => [state.store_connection_id, state]),
    );

    return {
      ok: true as const,
      shops: (shops ?? []).map(
        (shop): WooCommerceShopOption => ({
          id: shop.id,
          displayName: shop.display_name,
          domain: shop.shop_domain,
        }),
      ),
      canCreateNewShop: (connections ?? []).length === 0,
      connections: (connections ?? []).flatMap((connection): WooCommerceConnectionListItem[] => {
        const shop = shopById.get(connection.shop_id);
        if (!shop) return [];
        const sync = syncByConnection.get(connection.id);
        return [
          {
            id: connection.id,
            shopId: connection.shop_id,
            shopName: shop.display_name,
            shopDomain: shop.shop_domain,
            externalIdentifier: connection.external_identifier,
            status: connection.status,
            subscriptions: subscriptionsByConnection.get(connection.id) ?? {},
            syncStatus: sync?.status ?? null,
            syncLastErrorCode: sync?.last_error_code ?? null,
            syncLastPageObserved: sync?.last_page_observed ?? 0,
            syncUpdatedAt: sync?.updated_at ?? null,
          },
        ];
      }),
    };
  });

export const completeWooCommerceConnectionAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'woocommerce.connection.complete', section: 'shops' })
  .inputSchema(z.object({ connectionId: z.string().uuid() }))
  .action(async ({ ctx, parsedInput }) => {
    const admin = createSupabaseAdminClient();
    const { data: connection, error } = await admin
      .from('store_connection')
      .select('id, status')
      .eq('id', parsedInput.connectionId)
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .eq('platform', 'woocommerce')
      .maybeSingle();
    if (error || !connection)
      return { ok: false as const, errorCode: 'connection_not_found' as const };
    if (connection.status === 'needs_reauth') {
      return { ok: false as const, errorCode: 'credentials_invalid' as const };
    }

    const provision = await provisionWooCommerceSubscriptions(connection.id);
    if (!provision.ok) return provision;
    const sync = await synchronizeWooCommerceOrders(connection.id);
    if (!sync.ok && sync.errorCode !== 'sync_already_running') return sync;

    revalidatePath('/parametres');
    revalidatePath('/commandes');
    return { ok: true as const };
  });
