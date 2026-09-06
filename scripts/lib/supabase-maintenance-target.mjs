import { assertSupabaseHttpTarget } from '../../lib/security/supabase-target-policy.ts';

/** Controle une cible HTTP reservee a un script de maintenance explicite. */
export function assertMaintenanceSupabaseHttpTarget({
  target,
  variableName,
  allowedTarget,
  allowedVariableName,
}) {
  if (!allowedTarget?.trim()) {
    throw new Error(`${allowedVariableName}: cible absente`);
  }

  // La politique HTTP commune conserve la normalisation et les refus sans valeur.
  assertSupabaseHttpTarget({
    target,
    variableName,
    context: 'browser',
    allowedOrigins: [allowedTarget],
    requireExactAllowedOrigin: true,
  });
}
