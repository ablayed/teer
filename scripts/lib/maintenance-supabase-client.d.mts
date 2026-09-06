export type MaintenanceSupabaseClientInput = Readonly<{
  target: string | undefined;
  variableName: string;
  serviceRoleKey: string | undefined;
  allowedTarget: string | undefined;
  allowedVariableName: string;
}>;

export function createMaintenanceSupabaseClient(input: MaintenanceSupabaseClientInput): unknown;
