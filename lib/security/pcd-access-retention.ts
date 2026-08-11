/**
 * Provisional product default for the local purge caller. This is not stated
 * as a Senegalese legal obligation and is not activated by S1C-1.
 */
export const PCD_ACCESS_AUDIT_RETENTION_MONTHS = 12;

export function getPcdAccessAuditCutoff(now = new Date()): string {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - PCD_ACCESS_AUDIT_RETENTION_MONTHS);
  return cutoff.toISOString();
}
