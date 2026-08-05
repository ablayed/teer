import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PcdAccessAuditError,
  sanitizePcdAccessMetadata,
  writePcdAccessAudit,
} from '@/lib/security/pcd-access-audit';
import { detectPcdCategories } from '@/lib/security/pcd-detection';
import { sanitizePostHogEvent, sanitizeSentryEvent } from '@/lib/security/telemetry-sanitize';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CaptureResult } from 'posthog-js';
import { describe, expect, it, vi } from 'vitest';

const UUID = '00000000-0000-4000-8000-000000000001';

describe('S1C-1 DLP contract', () => {
  it('accepts only bounded technical metadata', () => {
    expect(sanitizePcdAccessMetadata({ source: 'unit', latency_ms: 12 })).toEqual({
      source: 'unit',
      latency_ms: 12,
    });
    expect(() => sanitizePcdAccessMetadata({ url: 'https://synthetic.invalid' })).toThrow(
      PcdAccessAuditError,
    );
    expect(() => sanitizePcdAccessMetadata({ unknown_key: 'synthetic' })).toThrow(
      PcdAccessAuditError,
    );
  });

  it('writes through the RPC and fails closed on an RPC error', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: UUID, error: null });
    const client = { rpc } as unknown as SupabaseClient<Database>;

    await expect(
      writePcdAccessAudit(client, {
        tenantId: UUID,
        actorKind: 'human',
        action: 'view_detail',
        dataCategory: 'customer_identity',
        purpose: 'order_fulfillment',
        outcome: 'succeeded',
        resourceType: 'order',
        resourceId: UUID,
        surface: 'server_action',
      }),
    ).resolves.toBe(UUID);

    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_actor_user_id).toBeUndefined();
    expect(args.p_metadata).toEqual({});

    rpc.mockResolvedValueOnce({ data: null, error: { code: 'synthetic_failure' } });
    await expect(
      writePcdAccessAudit(client, {
        tenantId: UUID,
        actorKind: 'human',
        action: 'generate_export',
        dataCategory: 'dsar_artifact',
        purpose: 'legal_request',
        outcome: 'succeeded',
        resourceType: 'dsar_artifact',
        surface: 'dsar',
      }),
    ).rejects.toThrow(PcdAccessAuditError);
  });

  it('detects only explicit synthetic contact/address forms', () => {
    expect(detectPcdCategories('Référence synthétique sans donnée sensible')).toEqual([]);
    expect(detectPcdCategories('Téléphone: +221 770000000')).toContain('customer_contact');
    expect(detectPcdCategories('Adresse: 12 rue Synthétique')).toContain('delivery_address');
  });

  it('removes URL, query, breadcrumb and exception content from Sentry', () => {
    const event = sanitizeSentryEvent({
      request: { url: 'https://synthetic.invalid/commandes?q=synthetic' },
      breadcrumbs: [{ category: 'http', message: 'synthetic sensitive text' }],
      exception: { values: [{ type: 'Error', value: 'synthetic sensitive text' }] },
      extra: { search: 'synthetic', pathname: '/commandes?q=synthetic' },
    });

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('synthetic sensitive text');
    expect(serialized).not.toContain('?q=');
    expect(event.request?.url).toBe('/commandes');
  });

  it('removes query, URL and free text properties from PostHog', () => {
    const event = sanitizePostHogEvent({
      event: '$pageview',
      properties: {
        $current_url: 'https://synthetic.invalid/commandes?q=synthetic',
        q: 'synthetic sensitive text',
        pathname: '/commandes',
      },
    } as unknown as CaptureResult);

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('synthetic sensitive text');
    expect(serialized).not.toContain('?q=');
  });

  it('keeps the immediate DLP call sites free of raw values', () => {
    const read = (file: string) => readFileSync(resolve(file), 'utf8');
    expect(read('sentry.client.config.ts')).not.toContain('search: window.location.search');
    expect(read('lib/ia/tools.ts')).not.toContain('toolArgs: rawArgs');
    expect(read('lib/ia/tools.ts')).not.toContain('execution_error: ${');
    expect(read('lib/ia/tools.ts')).not.toContain('fullName: row.full_name');
    expect(read('lib/actions/safe-action.ts')).not.toContain('message: error.message');
    expect(read('lib/shopify/shop-sync.ts')).not.toContain('extra: { payload');
    expect(read('lib/shopify/products-sync.ts')).not.toContain('extra: { payload');
    expect(read('app/api/shopify/dsar/[artifactId]/route.ts')).toContain('writePcdAccessAudit');
    expect(read('lib/shopify/dsar.ts')).toContain(".eq('shop_id', shopId)");
    expect(read('app/api/shopify/dsar/[artifactId]/route.ts')).toContain("'audit_unavailable'");
    expect(read('components/whatsapp/whatsapp-compose-sheet.tsx')).toContain(
      'recordWhatsappShareAction',
    );
    expect(read('components/whatsapp/whatsapp-compose-sheet.tsx')).toContain(
      'orderId: order.orderId',
    );
    expect(read('components/whatsapp/whatsapp-compose-sheet.tsx')).not.toContain(
      'orderId: order.numeroCommande',
    );
    expect(read('lib/actions/feedback.ts')).toContain('detectPcdCategories');
    expect(read('supabase/migrations/0123_s1c_pcd_access_audit.sql')).toContain(
      "tool_args = '{}'::jsonb",
    );
  });
});
