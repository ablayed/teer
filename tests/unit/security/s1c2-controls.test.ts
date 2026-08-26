import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PcdAccessAuditError,
  sanitizePcdAccessMetadata,
  sanitizePcdIdempotencyKey,
} from '@/lib/security/pcd-access-audit';
import {
  PCD_EXPORT_MAX_BYTES,
  PCD_EXPORT_MAX_ROWS,
  PCD_RECENT_AUTH_MAX_AGE_SECONDS,
  PcdAccessControlError,
  assertPcdExportBounds,
  isRecentAuthentication,
} from '@/lib/security/pcd-access-controls';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(file), 'utf8');
const SYNTHETIC_UUID = '00000000-0000-4000-8000-000000000001';

describe('S1C-2 bounded access and exfiltration controls', () => {
  it('uses server-derived recent authentication and ignores client freshness fields', () => {
    const now = new Date('2026-08-05T12:00:00.000Z');
    expect(isRecentAuthentication({ last_sign_in_at: '2026-08-05T11:55:00.000Z' }, now)).toBe(true);
    expect(isRecentAuthentication({ last_sign_in_at: '2026-08-05T11:44:59.000Z' }, now)).toBe(
      false,
    );
    expect(read('lib/security/pcd-access-controls.ts')).not.toContain('reauthenticated');
    expect(PCD_RECENT_AUTH_MAX_AGE_SECONDS).toBe(900);
  });

  it('bounds exports before content is returned', () => {
    expect(() => assertPcdExportBounds(PCD_EXPORT_MAX_ROWS)).not.toThrow();
    expect(() => assertPcdExportBounds(PCD_EXPORT_MAX_ROWS + 1)).toThrow(PcdAccessControlError);
    expect(() => assertPcdExportBounds(1, PCD_EXPORT_MAX_BYTES + 1)).toThrow(PcdAccessControlError);
  });

  it('rejects free values and keeps idempotency keys technical', () => {
    expect(sanitizePcdIdempotencyKey('request.synthetic-01')).toBe('request.synthetic-01');
    expect(sanitizePcdIdempotencyKey('synthetic query value')).toBeNull();
    expect(() => sanitizePcdAccessMetadata({ query: 'synthetic' })).toThrow(PcdAccessAuditError);
    expect(() => sanitizePcdAccessMetadata({ result_count: 5001 })).toThrow(PcdAccessAuditError);
  });

  it('proves the new routes are fail-closed and do not use signed URLs or query searches', () => {
    const migration = read('supabase/migrations/0124_s1c2_pcd_access_controls.sql');
    const dsarIssueRoute = read('app/api/shopify/dsar/[artifactId]/route.ts');
    const dsarDownloadRoute = read('app/api/shopify/dsar/[artifactId]/download/route.ts');
    const dsarLibrary = read('lib/shopify/dsar.ts');
    const searchClient = read('lib/orders/search-client.ts');
    const reportRoute = read('app/api/rapport/route.tsx');

    expect(migration).toContain('consume_shopify_dsar_download_authorization');
    expect(migration).toContain("extensions.digest(v_token, 'sha256')");
    expect(migration).toContain('consumed_at is null');
    expect(migration).toContain(
      'revoke all on table public.pcd_access_quota_policy, public.pcd_access_quota_bucket',
    );
    expect(dsarIssueRoute).toContain('issuePrivateDsarDownloadAuthorization');
    expect(dsarIssueRoute).toContain('generate_download_authorization');
    expect(dsarIssueRoute).not.toContain('createPrivateDsarSignedUrl');
    expect(dsarLibrary).not.toContain('createSignedUrl');
    expect(dsarDownloadRoute).toContain('x-teer-dsar-download-token');
    expect(dsarDownloadRoute).toContain('consumePrivateDsarDownloadAuthorization');
    expect(dsarDownloadRoute).toContain("'cache-control': 'private, no-store, max-age=0'");
    expect(searchClient).toContain("fetch('/api/orders/search'");
    expect(searchClient).toContain("method: 'POST'");
    expect(reportRoute).toContain('requireRecentAuthentication');
    expect(reportRoute).toContain("filename = 'teer-rapport.pdf'");
    expect(SYNTHETIC_UUID).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps every newly audited path free of raw PCD values and token URLs', () => {
    const orderActions = read('lib/actions/orders.ts');
    const customerActions = read('lib/actions/customers.ts');
    const whatsapp = read('lib/actions/pcd-access.ts');
    const feedback = read('lib/actions/feedback.ts');
    // Phase 2 / Verrou 0 : le pré-audit PCD du chemin webhook vit désormais dans le cœur partagé
    // (lib/shopify/webhook-core.ts, dispatchWebhookCore), appelé identiquement par les deux
    // endpoints (legacy et URL opaque) — plus dans app/api/shopify/webhooks/route.ts directement.
    const webhook = read('lib/shopify/webhook-core.ts');
    const webhookRoute = read('app/api/shopify/webhooks/route.ts');

    expect(orderActions).toContain('writePcdAccessAuditCategories');
    expect(customerActions).toContain('writePcdAccessAuditCategories');
    expect(whatsapp).toContain("action: 'external_share'");
    expect(whatsapp).not.toContain('metadata: { url');
    expect(feedback).toContain('detectPcdCategories');
    expect(webhook).toContain('idempotencyKey: `webhook:${eventId}:pcd-read`');
    expect(webhook).not.toContain('extra: { payload');
    expect(webhookRoute).not.toContain('extra: { payload');
  });
});
