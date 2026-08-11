import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PcdAccessAuditError, sanitizePcdAccessMetadata } from '@/lib/security/pcd-access-audit';
import { detectPcdCategories } from '@/lib/security/pcd-detection';
import { sanitizePostHogEvent, sanitizeSentryEvent } from '@/lib/security/telemetry-sanitize';
import type { CaptureResult } from 'posthog-js';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(file), 'utf8');

describe('S1C-3 dynamic DLP and declared-surface contract', () => {
  it('redacts synthetic canaries from Sentry and PostHog boundaries', () => {
    const canaries = {
      identity: 'S1C3_SYNTHETIC_NAME',
      contact: 'S1C3_SYNTHETIC_PHONE',
      address: 'S1C3_SYNTHETIC_ADDRESS',
      query: 'S1C3_SYNTHETIC_QUERY',
      dsar: 'S1C3_SYNTHETIC_DSAR',
      token: 'S1C3_SYNTHETIC_TOKEN',
      signedUrl: 'S1C3_SYNTHETIC_SIGNED_URL',
      payload: 'S1C3_SYNTHETIC_PAYLOAD',
      exception: 'S1C3_SYNTHETIC_EXCEPTION',
    };

    const sentry = sanitizeSentryEvent({
      request: { url: `https://synthetic.invalid/orders?q=${canaries.query}` },
      breadcrumbs: [{ category: 'http', message: canaries.dsar, data: canaries.payload }],
      exception: { values: [{ type: 'Error', value: canaries.exception }] },
      extra: {
        name: canaries.identity,
        phone: canaries.contact,
        address: canaries.address,
        token: canaries.token,
        url: canaries.signedUrl,
      },
    });
    const sentrySerialized = JSON.stringify(sentry);
    for (const value of Object.values(canaries)) {
      expect(sentrySerialized).not.toContain(value);
    }
    expect(sentry.request?.url).toBe('/orders');

    const posthog = sanitizePostHogEvent({
      event: 'synthetic_event',
      properties: {
        q: canaries.query,
        customer_name: canaries.identity,
        signed_url: canaries.signedUrl,
        dsar_token: canaries.token,
        payload: canaries.payload,
        pathname: '/orders',
      },
    } as unknown as CaptureResult);
    const posthogSerialized = JSON.stringify(posthog);
    for (const value of Object.values(canaries)) {
      expect(posthogSerialized).not.toContain(value);
    }
  });

  it('rejects every forbidden audit value shape before persistence', () => {
    const forbiddenKeys = [
      'name',
      'phone',
      'address',
      'query',
      'payload',
      'message',
      'args',
      'url',
      'token',
      'exception',
      'body',
    ] as const;
    for (const key of forbiddenKeys) {
      expect(() => sanitizePcdAccessMetadata({ [key]: 'S1C3_SYNTHETIC_VALUE' })).toThrow(
        PcdAccessAuditError,
      );
    }
    expect(() => sanitizePcdAccessMetadata({ source: 'S1C3_SYNTHETIC_VALUE'.repeat(30) })).toThrow(
      PcdAccessAuditError,
    );
    expect(() => sanitizePcdAccessMetadata({ result_count: 5001 })).toThrow(PcdAccessAuditError);
  });

  it('keeps the supported detector explicit and refuses before sensitive forwarding', () => {
    expect(detectPcdCategories('S1C3 synthetic operational text')).toEqual([]);
    expect(detectPcdCategories('Nom du client: S1C3_SYNTHETIC_NAME')).toContain(
      'customer_identity',
    );
    expect(detectPcdCategories('Téléphone: +221 770000000')).toContain('customer_contact');
    expect(detectPcdCategories('Adresse: 12 rue Synthétique')).toContain('delivery_address');
  });

  it('keeps all declared sensitive paths behind the S1C contracts', () => {
    const inventory = read('docs/security/s1c-3-validation.md');
    expect(inventory).toContain('S1C-3');

    const declaredFiles = [
      'lib/actions/orders.ts',
      'lib/actions/customers.ts',
      'lib/actions/team.ts',
      'lib/actions/finance.ts',
      'lib/actions/feedback.ts',
      'lib/actions/pcd-access.ts',
      'app/api/rapport/route.tsx',
      'app/api/assistant/chat/route.ts',
      'app/api/shopify/dsar/[artifactId]/route.ts',
      'app/api/shopify/dsar/[artifactId]/download/route.ts',
      'app/api/shopify/webhooks/route.ts',
      'lib/shopify/dsar.ts',
      'lib/security/pcd-access-audit.ts',
      'lib/security/telemetry-sanitize.ts',
    ];
    for (const file of declaredFiles) {
      expect(existsSync(resolve(file)), file).toBe(true);
    }

    expect(read('app/api/shopify/dsar/[artifactId]/download/route.ts')).toContain(
      'x-teer-dsar-download-token',
    );
    expect(read('app/api/shopify/dsar/[artifactId]/download/route.ts')).toContain(
      "'x-content-type-options': 'nosniff'",
    );
    expect(read('app/api/shopify/dsar/[artifactId]/download/route.ts')).not.toContain(
      'createSignedUrl',
    );
    expect(read('lib/security/pcd-access-audit.ts')).not.toContain('JSON.stringify(entry)');
    expect(read('lib/security/pcd-access-audit.ts')).toContain('sanitizePcdAccessMetadata');
  });
});
