import { ShopifyAppIdentityMismatchError } from '@/lib/shopify/app-identity-errors';
import { getShopifyAppByClientId } from '@/lib/shopify/apps';
import {
  extractShopifySessionAudience,
  verifyShopifySessionToken,
} from '@/lib/shopify/session-token';
import type { Database } from '@/lib/supabase/database.types';
import { createProtectedSupabaseClient } from '@/lib/supabase/protected-client';
import * as Sentry from '@sentry/nextjs';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// `process.env` direct, jamais `lib/env.ts` : ce module valide TOUTES les variables serveur au
// chargement (Zod), ce qui force un environnement de test complet pour importer ne serait-ce
// qu'une fonction pure d'un fichier qui l'importe transitivement (cf. CLAUDE.md). Même choix que
// `app/api/shopify/callback/route.ts`.
function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required for the Shopify embedded session route`);
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

function bearerToken(request: NextRequest): string | null {
  const authorization = request.headers.get('authorization');
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

function publicShopState(
  status: 'active' | 'uninstalled',
  shop: {
    shop_domain: string;
    installed_at: string;
    updated_at: string;
    last_reconciled_at: string | null;
  },
) {
  return {
    status: status === 'active' ? ('ready' as const) : ('uninstalled' as const),
    shop: {
      domain: shop.shop_domain,
      installedAt: shop.installed_at,
      lastSyncAt: shop.last_reconciled_at ?? null,
      updatedAt: shop.updated_at,
    },
    nextAction: status === 'active' ? ('open_cockpit' as const) : ('reinstall' as const),
  };
}

export async function GET(request: NextRequest) {
  const token = bearerToken(request);
  if (!token) {
    return NextResponse.json({ error: 'missing_session_token' }, { status: 401 });
  }

  // L'audience non vérifiée sert uniquement à sélectionner les credentials candidats. La
  // signature et les claims complets sont ensuite vérifiés avant toute lecture de boutique.
  const clientId = extractShopifySessionAudience(token);
  const app = clientId ? getShopifyAppByClientId(clientId) : null;
  if (!app) {
    return NextResponse.json({ error: 'unknown_shopify_app' }, { status: 401 });
  }

  const verification = verifyShopifySessionToken(token, {
    clientId: app.clientId,
    clientSecret: app.clientSecret,
  });
  if (!verification.ok) {
    return NextResponse.json({ error: 'invalid_session_token' }, { status: 401 });
  }

  const requestedShop = request.nextUrl.searchParams.get('shop')?.trim().toLowerCase();
  if (requestedShop && requestedShop !== verification.shopDomain) {
    return NextResponse.json({ error: 'shop_mismatch' }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const { data: shop, error } = await admin
    .from('shop')
    .select('shop_domain, shopify_client_id, status, installed_at, updated_at, last_reconciled_at')
    .eq('shop_domain', verification.shopDomain)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: 'shop_lookup_failed' }, { status: 500 });
  }

  if (!shop) {
    return NextResponse.json({
      status: 'not_configured' as const,
      shop: { domain: verification.shopDomain },
      nextAction: 'associate_teer' as const,
    });
  }

  // Confrontation stricte : l'app ayant vérifié l'ID token (`app.clientId`) doit être
  // exactement celle enregistrée sur la boutique. AUCUN repli implicite vers une app "par
  // défaut" quand `shopify_client_id` est absent — une boutique legacy sans client_id est un
  // désaccord, jamais une présomption Teer Dev. Divergence → jamais `ready`, aucune identité
  // historique (label, client_id, tenant) dans la réponse publique ; seule une capture Sentry
  // interne porte un code stable (jamais déduit du texte de message).
  if (shop.shopify_client_id !== app.clientId) {
    Sentry.captureException(new ShopifyAppIdentityMismatchError(), {
      tags: { route: 'shopify.embedded.session', reason: 'app_identity_mismatch' },
    });
    return NextResponse.json({ status: 'app_identity_mismatch' as const });
  }

  if (shop.status !== 'active' && shop.status !== 'uninstalled') {
    return NextResponse.json({ error: 'invalid_shop_status' }, { status: 500 });
  }

  return NextResponse.json(publicShopState(shop.status, shop));
}
