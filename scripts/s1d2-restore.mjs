import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEncryptedBackup, keyFromEnvironment } from './s1d2-backup-format.mjs';

const LOCAL_CONTAINER_PATTERN = /^supabase_db_[a-z0-9-]+$/;
const LOCAL_DATABASE_PATTERN = /^s1d2_(source|target)_[a-z0-9]+$/;

function fail() {
  throw new Error('restore operation failed');
}

function validateLocalTarget(container, database) {
  if (!LOCAL_CONTAINER_PATTERN.test(container) || !LOCAL_DATABASE_PATTERN.test(database)) {
    fail();
  }
}

function runDocker(args, input) {
  const result = spawnSync('docker', ['exec', '-i', ...args], {
    input,
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    fail();
  }
  return result.stdout ?? Buffer.alloc(0);
}

export async function restoreEncryptedBackupToLocal({
  archivePath,
  container,
  database,
  key,
  workspaceDir,
  confirmLocalRestore = false,
}) {
  if (!confirmLocalRestore) {
    fail();
  }
  validateLocalTarget(container, database);
  const extractionDir = resolve(workspaceDir);
  await mkdir(extractionDir, { recursive: true });
  try {
    const result = await extractEncryptedBackup({
      archivePath,
      outputDir: extractionDir,
      key,
    });
    const dbDump = await readFile(join(extractionDir, 'db.sql'));
    runDocker(
      [container, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'],
      Buffer.concat([
        Buffer.from('set session_replication_role = replica;\n', 'utf8'),
        dbDump,
        Buffer.from('\nset session_replication_role = origin;\n', 'utf8'),
      ]),
    );
    try {
      const privileges = await readFile(join(extractionDir, 'roles-and-privileges.sql'));
      runDocker(
        [container, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'],
        privileges,
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return {
      database,
      componentCount: result.payload.components.length,
    };
  } finally {
    await rm(extractionDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (!args.includes('--confirm-local-restore')) {
    fail();
  }
  await restoreEncryptedBackupToLocal({
    archivePath: value('--archive'),
    container: value('--container'),
    database: value('--database'),
    key: keyFromEnvironment(),
    workspaceDir: value('--workspace-dir'),
    confirmLocalRestore: true,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('restore operation failed\n');
    process.exitCode = 1;
  });
}
