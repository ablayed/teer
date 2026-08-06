export const BACKUP_FORMAT_VERSION: number;
export const BACKUP_ALGORITHM: string;
export const BACKUP_KEY_ENV: string;

export function parseBackupKey(value: unknown): Buffer;
export function keyFromEnvironment(env?: NodeJS.ProcessEnv): Buffer;
export function createEncryptedBackup(args: {
  inputDir: string;
  outputPath: string;
  key: Buffer;
  metadata?: Record<string, unknown>;
}): Promise<{ outputPath: string; bytes: number; components: number }>;
export function readEncryptedBackup(args: {
  archivePath: string;
  key: Buffer;
}): Promise<{ header: Record<string, unknown>; payload: Record<string, unknown> }>;
export function extractEncryptedBackup(args: {
  archivePath: string;
  outputDir: string;
  key: Buffer;
}): Promise<{
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  outputDir: string;
}>;
export function archiveContainsPlaintext(args: {
  archivePath: string;
  plaintext: string;
}): Promise<boolean>;
