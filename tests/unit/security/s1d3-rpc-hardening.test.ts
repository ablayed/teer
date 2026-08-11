import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PCD_ACCESS_ACTIONS,
  PCD_ACCESS_ACTOR_KINDS,
  PCD_ACCESS_CATEGORIES,
  PCD_ACCESS_OUTCOMES,
  PCD_ACCESS_PURPOSES,
  PCD_ACCESS_RESOURCE_TYPES,
  PCD_ACCESS_SERVICE_KINDS,
  PCD_ACCESS_SURFACES,
  PcdAccessAuditError,
  sanitizePcdAccessMetadata,
} from '@/lib/security/pcd-access-audit';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0125_s1d3_harden_pcd_access_audit_rpc.sql'),
  'utf8',
);

describe('S1D-3R SQL RPC contract', () => {
  it('keeps the closed TypeScript lists represented in SQL', () => {
    for (const value of [
      ...PCD_ACCESS_ACTIONS,
      ...PCD_ACCESS_ACTOR_KINDS,
      ...PCD_ACCESS_CATEGORIES,
      ...PCD_ACCESS_PURPOSES,
      ...PCD_ACCESS_OUTCOMES,
      ...PCD_ACCESS_RESOURCE_TYPES,
      ...PCD_ACCESS_SERVICE_KINDS,
      ...PCD_ACCESS_SURFACES,
    ]) {
      expect(migration).toContain(`'${value}'`);
    }
  });

  it('uses the same fail-closed technical metadata boundary as SQL', () => {
    expect(() => sanitizePcdAccessMetadata({ source: null as never })).toThrow(PcdAccessAuditError);
    expect(() => sanitizePcdAccessMetadata({ source: 'synthetic free text' })).toThrow(
      PcdAccessAuditError,
    );
    expect(() => sanitizePcdAccessMetadata({ source: 'synthetic\u0000control' })).toThrow(
      PcdAccessAuditError,
    );
    expect(migration).toContain("jsonb_typeof(v_value) not in ('string', 'number', 'boolean')");
    expect(migration).toContain("v_text !~ '^[A-Za-z0-9._:-]+$'");
    expect(migration).toContain('revoke all on function public.log_pcd_access_event');
  });
});
