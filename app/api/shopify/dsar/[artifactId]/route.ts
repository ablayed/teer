import { writePcdAccessAudit } from '@/lib/security/pcd-access-audit';
import {
  PcdAccessControlError,
  consumePcdQuota,
  requireRecentAuthentication,
} from '@/lib/security/pcd-access-controls';
import { issuePrivateDsarDownloadAuthorization } from '@/lib/shopify/dsar';
import type { Database } from '@/lib/supabase/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  const requestedShopId = new URL(request.url).searchParams.get('shop_id');
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(artifactId) || !requestedShopId || !uuidPattern.test(requestedShopId)) {
    return NextResponse.json({ error: 'artifact_unavailable' }, { status: 404 });
  }

  try {
    await requireRecentAuthentication(auditClient);
    await consumePcdQuota(auditClient, {
      action: 'generate_download_authorization',
      actorKind: 'human',
      shopId: requestedShopId,
      tenantId: member.merchant_account_id,
    });
  } catch (error) {
    const status =
      error instanceof PcdAccessControlError
        ? error.code === 'recent_authentication_required'
          ? 401
          : error.code === 'quota_exceeded'
            ? 429
            : 503
        : 503;
    try {
      await writePcdAccessAudit(auditClient, {
        tenantId: member.merchant_account_id,
        shopId: requestedShopId,
        actorKind: 'human',
        action: 'generate_download_authorization',
        dataCategory: 'dsar_artifact',
        purpose: 'legal_request',
        outcome: 'denied',
        resourceType: 'dsar_artifact',
        resourceId: artifactId,
        surface: 'dsar',
        metadata: {
          reason_code: error instanceof PcdAccessControlError ? error.code : 'control_unavailable',
        },
      });
    } catch {
      // Aucun artefact ni jeton n'est retourné.
    }
    return NextResponse.json(
      { error: status === 429 ? 'rate_limited' : 'reauthentication_required' },
      { status },
    );
  }

  try {
    const result = await issuePrivateDsarDownloadAuthorization(auditClient, {
      artifactId,
      merchantAccountId: member.merchant_account_id,
      shopId: requestedShopId,
    });

    try {
      await writePcdAccessAudit(auditClient, {
        tenantId: member.merchant_account_id,
        shopId: requestedShopId,
        actorKind: 'human',
        action: 'generate_download_authorization',
        dataCategory: 'dsar_artifact',
        purpose: 'legal_request',
        outcome: 'succeeded',
        resourceType: 'dsar_artifact',
        resourceId: artifactId,
        surface: 'dsar',
      });
    } catch {
      return NextResponse.json({ error: 'audit_unavailable' }, { status: 503 });
    }

    return NextResponse.json(
      {
        ...result,
        downloadPath: `/api/shopify/dsar/${artifactId}/download?shop_id=${requestedShopId}`,
      },
      { headers: { 'cache-control': 'private, no-store, max-age=0', pragma: 'no-cache' } },
    );
  } catch {
    try {
      await writePcdAccessAudit(auditClient, {
        tenantId: member.merchant_account_id,
        shopId: requestedShopId,
        actorKind: 'human',
        action: 'generate_download_authorization',
        dataCategory: 'dsar_artifact',
        purpose: 'legal_request',
        outcome: 'denied',
        resourceType: 'dsar_artifact',
        resourceId: artifactId,
        surface: 'dsar',
        metadata: { reason_code: 'artifact_unavailable' },
      });
    } catch {
      // L'accès reste refusé ; aucun artefact ni URL n'est retourné.
    }
    return NextResponse.json({ error: 'artifact_unavailable' }, { status: 404 });
  }
}
