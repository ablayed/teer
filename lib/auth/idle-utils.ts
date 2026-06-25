export function isWarning(
  lastActivity: number,
  now: number,
  timeoutMs: number,
  warningMs: number,
): boolean {
  const elapsed = now - lastActivity;
  return elapsed >= timeoutMs - warningMs && elapsed < timeoutMs;
}

export function isExpired(lastActivity: number, now: number, timeoutMs: number): boolean {
  return now - lastActivity >= timeoutMs;
}

export function getCountdown(lastActivity: number, now: number, timeoutMs: number): number {
  const remaining = timeoutMs - (now - lastActivity);
  return Math.max(0, Math.ceil(remaining / 1000));
}
