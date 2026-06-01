import { createSupabaseServerClient } from '@/lib/supabase/server';
import { type NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const redirectTo = requestUrl.searchParams.get('redirectTo');

  if (code) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.exchangeCodeForSession(code);
  }

  const safeRedirectTo =
    redirectTo?.startsWith('/') && !redirectTo.startsWith('//') ? redirectTo : '/tableau';

  return NextResponse.redirect(new URL(safeRedirectTo, requestUrl.origin));
}
