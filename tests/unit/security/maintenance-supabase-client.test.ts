import { afterEach, describe, expect, it, vi } from 'vitest';

const createClient = vi.fn(() => ({ marker: 'client-maintenance-cree' }));
vi.mock('@supabase/supabase-js', () => ({ createClient }));

const scripts = [
  {
    variableName: 'L2_MAINTENANCE_SUPABASE_URL',
    allowedVariableName: 'L2_MAINTENANCE_SUPABASE_ALLOWED_ORIGIN',
  },
  {
    variableName: 'L3_MAINTENANCE_SUPABASE_URL',
    allowedVariableName: 'L3_MAINTENANCE_SUPABASE_ALLOWED_ORIGIN',
  },
  {
    variableName: 'WEBHOOK_MIGRATION_SUPABASE_URL',
    allowedVariableName: 'WEBHOOK_MIGRATION_SUPABASE_ALLOWED_ORIGIN',
  },
] as const;

afterEach(() => {
  createClient.mockClear();
});

describe('canal HTTP de maintenance', () => {
  it.each(scripts)(
    '$variableName refuse sans configuration dediee avant le constructeur',
    async ({ variableName, allowedVariableName }) => {
      const { createMaintenanceSupabaseClient } = await import(
        '../../../scripts/lib/maintenance-supabase-client.mjs'
      );

      expect(() =>
        createMaintenanceSupabaseClient({
          target: undefined,
          variableName,
          serviceRoleKey: undefined,
          allowedTarget: 'https://maintenance-synthetique.example.test',
          allowedVariableName,
        }),
      ).toThrow(/configuration de maintenance dediee requise/);
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it.each(scripts)(
    '$variableName construit le client avec sa configuration dediee valide',
    async ({ variableName, allowedVariableName }) => {
      const { createMaintenanceSupabaseClient } = await import(
        '../../../scripts/lib/maintenance-supabase-client.mjs'
      );
      const target = 'https://maintenance-synthetique.example.test';

      expect(
        createMaintenanceSupabaseClient({
          target,
          variableName,
          serviceRoleKey: 'cle-synthetique',
          allowedTarget: target,
          allowedVariableName,
        }),
      ).toEqual({ marker: 'client-maintenance-cree' });
      expect(createClient).toHaveBeenCalledOnce();
    },
  );
});
