export function restoreEncryptedBackupToLocal(args: {
  archivePath: string;
  container: string;
  database: string;
  key: Buffer;
  workspaceDir: string;
  confirmLocalRestore?: boolean;
}): Promise<{ database: string; componentCount: number }>;
