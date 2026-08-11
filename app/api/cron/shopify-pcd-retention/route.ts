import { timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_PCD_RETENTION_BATCH,
  MAX_PCD_RETENTION_BATCH,
  executeShopifyPcdRetention,
  previewShopifyPcdRetention,
} from '@/lib/shopify/pcd-retention';
import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function hasValidCronSecret(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  const authorization = request.headers.get('authorization') ?? '';
  const provided = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';

  if (!expected || !provided) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function parseLimit(value: string | null): number {
  if (value === null || value === '') {
    return DEFAULT_PCD_RETENTION_BATCH;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_PCD_RETENTION_BATCH ? parsed : 0;
}

export async function GET(request: Request) {
  if (!hasValidCronSecret(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') ?? 'dry-run';
  const limit = parseLimit(url.searchParams.get('limit'));
  if (!['dry-run', 'execute'].includes(mode) || limit === 0) {
    return NextResponse.json({ error: 'invalid_retention_parameters' }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({ error: 'missing_env' }, { status: 500 });
  }

  try {
    if (mode === 'dry-run') {
      const preview = await previewShopifyPcdRetention(admin);
      return NextResponse.json(
        { mode: 'dry_run', preview },
        { headers: { 'cache-control': 'no-store' } },
      );
    }

    const summary = await executeShopifyPcdRetention(admin, limit);
    return NextResponse.json(summary, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'retention_execution_failed' }, { status: 500 });
  }
}
