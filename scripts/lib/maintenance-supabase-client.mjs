import { createClient } from '@supabase/supabase-js';
import { assertMaintenanceSupabaseHttpTarget } from './supabase-maintenance-target.mjs';

/** Cree un client de maintenance apres verification de sa configuration dediee. */
export function createMaintenanceSupabaseClient({
  target,
  variableName,
  serviceRoleKey,
  allowedTarget,
  allowedVariableName,
}) {
  if (!target || !serviceRoleKey) {
    throw new Error(`${variableName}: configuration de maintenance dediee requise`);
  }

  assertMaintenanceSupabaseHttpTarget({
    target,
    variableName,
    allowedTarget,
    allowedVariableName,
  });

  return createClient(target, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
