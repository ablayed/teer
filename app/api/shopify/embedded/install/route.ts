import { validateShopDomain } from '@/lib/shopify/oauth';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function redirectToLogin(request: NextRequest, shop: string, host: string) {
  const installPath = `/api/shopify/embedded/install?shop=${encodeURIComponent(shop)}${host ? `&host=${encodeURIComponent(host)}` : ''}`;
  return NextResponse.redirect(
    new URL(`/connexion?redirectTo=${encodeURIComponent(installPath)}`, request.url),
  );
}

export async function GET(request: NextRequest) {
  const shop = request.nextUrl.searchParams.get('shop')?.trim().toLowerCase() ?? '';
  const host = request.nextUrl.searchParams.get('host')?.trim() ?? '';

  if (!validateShopDomain(shop)) {
    return NextResponse.json({ error: 'invalid_shop' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return redirectToLogin(request, shop, host);
  }

  const returnTo = `/shopify/embedded${host ? `?host=${encodeURIComponent(host)}` : ''}`;
  const installUrl = new URL('/api/shopify/install', request.url);
  installUrl.searchParams.set('shop', shop);
  installUrl.searchParams.set('return_to', returnTo);

  return NextResponse.redirect(installUrl);
}
