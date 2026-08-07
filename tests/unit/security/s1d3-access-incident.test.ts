import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PcdAccessAuditError, sanitizePcdAccessMetadata } from '@/lib/security/pcd-access-audit';
import {
  type PcdSecurityEvent,
  PcdSecurityEventError,
  detectPcdAnomalies,
} from '@/lib/security/pcd-anomaly-detection';
import { sanitizePostHogEvent, sanitizeSentryEvent } from '@/lib/security/telemetry-sanitize';
import type { CaptureResult } from 'posthog-js';
import { describe, expect, it } from 'vitest';

const SYNTHETIC_PCD = 'S1D3_SYNTHETIC_CUSTOMER_MARKER';
const at = (seconds: number) => new Date(Date.UTC(2026, 7, 7, 12, 0, seconds)).toISOString();

describe('S1D-3 privileged access and incident exercise', () => {
  it('detects a synthetic cross-tenant incident and the containment signals', () => {
    const events: PcdSecurityEvent[] = [0, 1, 2].map((second) => ({
      occurredAt: at(second),
      kind: 'pcd_access' as const,
      actorKey: 'actor-synthetic-1',
      actorKind: 'human' as const,
      tenantKey: 'tenant-synthetic-a',
      action: 'view_detail',
      outcome: 'denied' as const,
      metadata: { reason_code: 'cross_tenant' },
    }));
    events.push({
      occurredAt: at(3),
      kind: 'audit_mutation_attempt',
      actorKey: 'actor-synthetic-1',
      actorKind: 'human',
      tenantKey: 'tenant-synthetic-a',
      metadata: { reason_code: 'append_only' },
    });
    events.push({
      occurredAt: at(4),
      kind: 'revoked_credential_use',
      actorKey: 'credential-synthetic-revoked',
      actorKind: 'service',
      metadata: { reason_code: 'revoked' },
    });

    const anomalies = detectPcdAnomalies(events);
    expect(anomalies.map((item) => item.rule)).toEqual(
      expect.arrayContaining([
        'repeated_cross_tenant_denials',
        'audit_mutation_attempt',
        'revoked_credential_use',
      ]),
    );
    expect(JSON.stringify(anomalies)).not.toContain(SYNTHETIC_PCD);

    const revokedCredentials = new Set(['credential-synthetic-revoked']);
    revokedCredentials.delete('credential-synthetic-revoked');
    expect(revokedCredentials.has('credential-synthetic-revoked')).toBe(false);
  });

  it('detects excessive export, multi-tenant access and privileged failure bursts', () => {
    const exportEvents = Array.from({ length: 5 }, (_, index) => ({
      occurredAt: at(index),
      kind: 'pcd_access' as const,
      actorKey: 'actor-synthetic-export',
      actorKind: 'human' as const,
      tenantKey: 'tenant-synthetic-a',
      action: 'generate_export',
      outcome: 'succeeded' as const,
    }));
    const authFailures = Array.from({ length: 5 }, (_, index) => ({
      occurredAt: at(index),
      kind: 'authorization_failure' as const,
      actorKey: 'actor-synthetic-auth',
      actorKind: 'human' as const,
    }));
    const multiTenant = [
      {
        occurredAt: at(0),
        kind: 'pcd_access' as const,
        actorKey: 'actor-synthetic-multi',
        actorKind: 'human' as const,
        tenantKey: 'tenant-synthetic-a',
        outcome: 'succeeded' as const,
      },
      {
        occurredAt: at(1),
        kind: 'pcd_access' as const,
        actorKey: 'actor-synthetic-multi',
        actorKind: 'human' as const,
        tenantKey: 'tenant-synthetic-b',
        outcome: 'succeeded' as const,
      },
    ];

    const rules = detectPcdAnomalies([...exportEvents, ...authFailures, ...multiTenant]).map(
      (item) => item.rule,
    );
    expect(rules).toEqual(
      expect.arrayContaining([
        'excessive_export',
        'privileged_auth_failure_burst',
        'actor_multiple_tenants',
      ]),
    );
  });

  it('rejects sensitive event metadata before local analysis', () => {
    expect(() =>
      detectPcdAnomalies([
        {
          occurredAt: at(0),
          kind: 'pcd_access',
          actorKey: 'actor-synthetic',
          actorKind: 'human',
          metadata: { reason_code: SYNTHETIC_PCD } as never,
        },
      ]),
    ).not.toThrow();
    expect(() =>
      detectPcdAnomalies([
        {
          occurredAt: at(0),
          kind: 'pcd_access',
          actorKey: 'actor-synthetic',
          actorKind: 'human',
          metadata: { email: 'synthetic@example.invalid' } as never,
        },
      ]),
    ).toThrow(PcdSecurityEventError);
    expect(() => sanitizePcdAccessMetadata({ reason_code: 'synthetic free text' })).toThrow(
      PcdAccessAuditError,
    );
  });

  it('keeps telemetry and CI artefact boundaries free of raw values', () => {
    const sentry = sanitizeSentryEvent({
      request: { url: `https://synthetic.invalid/orders?q=${SYNTHETIC_PCD}` },
      breadcrumbs: [{ category: 'security', message: SYNTHETIC_PCD }],
      exception: { values: [{ type: 'Error', value: SYNTHETIC_PCD }] },
    });
    const posthog = sanitizePostHogEvent({
      event: 'security_event',
      properties: { payload: SYNTHETIC_PCD, pathname: '/commandes' },
    } as unknown as CaptureResult);
    expect(JSON.stringify(sentry)).not.toContain(SYNTHETIC_PCD);
    expect(JSON.stringify(posthog)).not.toContain(SYNTHETIC_PCD);

    for (const workflow of readdirSync(resolve('.github/workflows'))) {
      if (!workflow.endsWith('.yml') && !workflow.endsWith('.yaml')) continue;
      const content = readFileSync(resolve('.github/workflows', workflow), 'utf8');
      expect(content, workflow).not.toMatch(/echo\s+"SUPABASE_SERVICE_ROLE_KEY=\$\{/);
      if (content.includes('.env.production')) {
        expect(content, workflow).toContain('Remove test environment files');
      }
    }
  });
});
