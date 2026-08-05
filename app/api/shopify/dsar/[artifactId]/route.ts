import { createPrivateDsarSignedUrl, createStorageAdminClient } from '@/lib/shopify/dsar';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ artifactId: string }> },
) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { data: memberData, error: memberError } = await supabase
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  const member = memberData as { merchant_account_id: string; role: string } | null;
  if (memberError || !member || !['owner', 'manager'].includes(member.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { artifactId } = await params;
  try {
    const result = await createPrivateDsarSignedUrl(createStorageAdminClient(), {
      artifactId,
      merchantAccountId: member.merchant_account_id,
    });
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'artifact_unavailable' }, { status: 404 });
  }
}
