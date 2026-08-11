export type PcdSecurityEventKind =
  | 'pcd_access'
  | 'authorization_failure'
  | 'audit_mutation_attempt'
  | 'revoked_credential_use';

export type PcdSecurityEvent = {
  occurredAt: string;
  kind: PcdSecurityEventKind;
  actorKey: string;
  actorKind: 'human' | 'service';
  tenantKey?: string | null;
  action?: string;
  outcome?: 'allowed' | 'denied' | 'succeeded' | 'failed';
  serviceKind?: string | null;
  metadata?: {
    reason_code?: string | null;
    result_count?: number | null;
    source?: string | null;
  };
};

export type PcdAnomalyRule =
  | 'repeated_cross_tenant_denials'
  | 'support_exception_access'
  | 'excessive_export'
  | 'actor_multiple_tenants'
  | 'privileged_auth_failure_burst'
  | 'audit_mutation_attempt'
  | 'revoked_credential_use'
  | 'unexpected_service_role';

export type PcdAnomaly = {
  rule: PcdAnomalyRule;
  severity: 'medium' | 'high' | 'critical';
  evidenceCount: number;
  actorKey: string;
};

export const PCD_ANOMALY_WINDOW_SECONDS = 15 * 60;
export const PCD_CROSS_TENANT_DENIAL_THRESHOLD = 3;
export const PCD_EXPORT_THRESHOLD = 5;
export const PCD_AUTH_FAILURE_THRESHOLD = 5;

const FORBIDDEN_METADATA_KEYS = new Set([
  'address',
  'body',
  'email',
  'exception',
  'message',
  'name',
  'payload',
  'phone',
  'query',
  'token',
  'url',
]);

const SENSITIVE_VALUE_PATTERNS = [
  /https?:\/\//i,
  /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i,
  /(?:\+?\d[\s().-]?){8,}/,
];

export class PcdSecurityEventError extends Error {
  constructor() {
    super('pcd_security_event_rejected');
    this.name = 'PcdSecurityEventError';
  }
}

function assertSafeEvent(event: PcdSecurityEvent): void {
  if (
    !event.actorKey ||
    event.actorKey.length > 128 ||
    !Number.isFinite(Date.parse(event.occurredAt))
  ) {
    throw new PcdSecurityEventError();
  }

  for (const [key, value] of Object.entries(event.metadata ?? {})) {
    if (
      FORBIDDEN_METADATA_KEYS.has(key) ||
      !['reason_code', 'result_count', 'source'].includes(key)
    ) {
      throw new PcdSecurityEventError();
    }
    if (
      typeof value === 'string' &&
      (value.length > 128 || SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value)))
    ) {
      throw new PcdSecurityEventError();
    }
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0 || value > 5000)) {
      throw new PcdSecurityEventError();
    }
  }
}

function eventTime(event: PcdSecurityEvent): number {
  return Date.parse(event.occurredAt);
}

function inWindow(events: PcdSecurityEvent[], anchor: PcdSecurityEvent): PcdSecurityEvent[] {
  const end = eventTime(anchor);
  return events.filter((event) => {
    const delta = end - eventTime(event);
    return delta >= 0 && delta <= PCD_ANOMALY_WINDOW_SECONDS * 1_000;
  });
}

function addGroupedAnomalies(
  output: PcdAnomaly[],
  events: PcdSecurityEvent[],
  predicate: (event: PcdSecurityEvent) => boolean,
  rule: PcdAnomalyRule,
  severity: PcdAnomaly['severity'],
  threshold: number,
): void {
  const groups = new Map<string, PcdSecurityEvent[]>();
  for (const event of events) {
    if (!predicate(event)) continue;
    const group = groups.get(event.actorKey) ?? [];
    group.push(event);
    groups.set(event.actorKey, group);
  }

  for (const [actorKey, group] of groups) {
    const anchor = group.at(-1);
    if (!anchor) continue;
    const count = inWindow(group, anchor).length;
    if (count >= threshold) {
      output.push({ rule, severity, evidenceCount: count, actorKey });
    }
  }
}

/**
 * Local, deterministic MVP detection over already-sanitized security metadata.
 * It produces no external alert and never includes PCD values in its output.
 */
export function detectPcdAnomalies(input: readonly PcdSecurityEvent[]): PcdAnomaly[] {
  const events = [...input].sort((left, right) => eventTime(left) - eventTime(right));
  events.forEach(assertSafeEvent);
  const anomalies: PcdAnomaly[] = [];

  addGroupedAnomalies(
    anomalies,
    events,
    (event) =>
      event.kind === 'pcd_access' &&
      event.outcome === 'denied' &&
      event.metadata?.reason_code === 'cross_tenant',
    'repeated_cross_tenant_denials',
    'high',
    PCD_CROSS_TENANT_DENIAL_THRESHOLD,
  );

  for (const event of events) {
    if (event.kind === 'pcd_access' && event.metadata?.reason_code === 'support_exception') {
      anomalies.push({
        rule: 'support_exception_access',
        severity: 'high',
        evidenceCount: 1,
        actorKey: event.actorKey,
      });
    }
    if (event.kind === 'audit_mutation_attempt') {
      anomalies.push({
        rule: 'audit_mutation_attempt',
        severity: 'critical',
        evidenceCount: 1,
        actorKey: event.actorKey,
      });
    }
    if (event.kind === 'revoked_credential_use') {
      anomalies.push({
        rule: 'revoked_credential_use',
        severity: 'critical',
        evidenceCount: 1,
        actorKey: event.actorKey,
      });
    }
    if (
      event.kind === 'pcd_access' &&
      event.actorKind === 'service' &&
      event.serviceKind === 'service_role' &&
      event.metadata?.reason_code === 'unexpected_service_role'
    ) {
      anomalies.push({
        rule: 'unexpected_service_role',
        severity: 'critical',
        evidenceCount: 1,
        actorKey: event.actorKey,
      });
    }
  }

  addGroupedAnomalies(
    anomalies,
    events,
    (event) =>
      event.kind === 'pcd_access' &&
      ['generate_export', 'download_export'].includes(event.action ?? '') &&
      ['allowed', 'succeeded'].includes(event.outcome ?? ''),
    'excessive_export',
    'high',
    PCD_EXPORT_THRESHOLD,
  );

  addGroupedAnomalies(
    anomalies,
    events,
    (event) => event.kind === 'authorization_failure',
    'privileged_auth_failure_burst',
    'medium',
    PCD_AUTH_FAILURE_THRESHOLD,
  );

  const actorEvents = new Map<string, PcdSecurityEvent[]>();
  for (const event of events) {
    if (event.kind !== 'pcd_access' || !event.tenantKey) continue;
    const group = actorEvents.get(event.actorKey) ?? [];
    group.push(event);
    actorEvents.set(event.actorKey, group);
  }
  for (const [actorKey, group] of actorEvents) {
    const anchor = group.at(-1);
    if (!anchor) continue;
    const tenants = new Set(inWindow(group, anchor).map((event) => event.tenantKey));
    if (tenants.size > 1) {
      anomalies.push({
        rule: 'actor_multiple_tenants',
        severity: 'high',
        evidenceCount: tenants.size,
        actorKey,
      });
    }
  }

  return anomalies;
}
