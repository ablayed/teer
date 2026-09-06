export type MaintenanceSupabaseHttpTargetInput = Readonly<{
  target: string | undefined;
  variableName: string;
  allowedTarget: string | undefined;
  allowedVariableName: string;
}>;

export function assertMaintenanceSupabaseHttpTarget(
  input: MaintenanceSupabaseHttpTargetInput,
): void;
