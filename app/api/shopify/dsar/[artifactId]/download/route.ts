import { writePcdAccessAudit } from '@/lib/security/pcd-access-audit';
import { createStorageAdminClient, downloadPrivateDsarArtifact } from '@/lib/shopify/dsar';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ artifactId: string }> },
) {
  const supabase = await createSupabaseServerClient();
  const auditClient = supabase as unknown as SupabaseClient<Database>;
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
  const shopId = new URL(request.url).searchParams.get('shop_id');
  if (!UUID_PATTERN.test(artifactId) || !shopId || !UUID_PATTERN.test(shopId)) {
    return NextResponse.json({ error: 'artifact_unavailable' }, { status: 404 });
  }

  try {
    await writePcdAccessAudit(auditClient, {
      tenantId: member.merchant_account_id,
      shopId,
      actorKind: 'human',
      action: 'download_export',
      dataCategory: 'dsar_artifact',
      purpose: 'legal_request',
      outcome: 'allowed',
      resourceType: 'dsar_artifact',
      resourceId: artifactId,
      surface: 'dsar',
    });
  } catch {
    return NextResponse.json({ error: 'audit_unavailable' }, { status: 503 });
  }

  try {
    const { body } = await downloadPrivateDsarArtifact(createStorageAdminClient(), {
      artifactId,
      merchantAccountId: member.merchant_account_id,
      shopId,
    });

    return new NextResponse(body, {
      headers: {
        'cache-control': 'no-store',
        'content-disposition': 'attachment; filename="dsar-export.json"',
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    try {
      await writePcdAccessAudit(auditClient, {
        tenantId: member.merchant_account_id,
        shopId,
        actorKind: 'human',
        action: 'download_export',
        dataCategory: 'dsar_artifact',
        purpose: 'legal_request',
        outcome: 'failed',
        resourceType: 'dsar_artifact',
        resourceId: artifactId,
        surface: 'dsar',
        metadata: { reason_code: 'artifact_unavailable' },
      });
    } catch {
      // Aucun contenu n'a été retourné ; le refus reste fermé.
    }
    return NextResponse.json({ error: 'artifact_unavailable' }, { status: 404 });
  }
}
