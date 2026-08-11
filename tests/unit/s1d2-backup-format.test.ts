import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveContainsPlaintext,
  createEncryptedBackup,
  extractEncryptedBackup,
  parseBackupKey,
  readEncryptedBackup,
} from '../../scripts/s1d2-backup-format.mjs';
import { restoreEncryptedBackupToLocal } from '../../scripts/s1d2-restore.mjs';

const workspaces: string[] = [];
const syntheticKey = Buffer.alloc(32, 0x5a);

async function workspace() {
  const path = await mkdtemp(join(tmpdir(), 's1d2-format-'));
  workspaces.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('S1D-2 encrypted backup format', () => {
  it('creates an authenticated archive with an encrypted manifest', async () => {
    const root = await workspace();
    const input = join(root, 'input');
    const archive = join(root, 'backup.s1d2');
    await mkdir(input, { recursive: true });
    await writeFile(join(input, 'db.sql'), 'S1D2_SYNTHETIC_SENTINEL', { flag: 'wx' });
    await writeFile(join(input, 'storage-object-0001.bin'), Buffer.from([1, 2, 3]), { flag: 'wx' });

    await createEncryptedBackup({ inputDir: input, outputPath: archive, key: syntheticKey });
    expect(
      await archiveContainsPlaintext({
        archivePath: archive,
        plaintext: 'S1D2_SYNTHETIC_SENTINEL',
      }),
    ).toBe(false);
    const result = await readEncryptedBackup({ archivePath: archive, key: syntheticKey });
    expect(result.header.formatVersion).toBe(1);
    expect(
      (result.payload.components as Array<{ name: string }>).map((component) => component.name),
    ).toEqual(['db.sql', 'storage-object-0001.bin']);
  });

  it('rejects missing, malformed and wrong keys without exposing details', async () => {
    expect(() => parseBackupKey(undefined)).toThrow('backup operation failed');
    expect(() => parseBackupKey('not-a-key')).toThrow('backup operation failed');
    expect(() => parseBackupKey('a'.repeat(64))).not.toThrow();
  });

  it('rejects ciphertext alteration, truncation, checksum mismatch and unknown format', async () => {
    const root = await workspace();
    const input = join(root, 'input');
    const archive = join(root, 'backup.s1d2');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(input, { recursive: true }));
    await writeFile(join(input, 'db.sql'), 'synthetic database dump', { flag: 'wx' });
    await createEncryptedBackup({ inputDir: input, outputPath: archive, key: syntheticKey });
    const original = await readFile(archive);

    const altered = Buffer.from(original);
    altered[altered.length - 20] ^= 0x01;
    await writeFile(join(root, 'altered.s1d2'), altered, { flag: 'wx' });
    await expect(
      readEncryptedBackup({ archivePath: join(root, 'altered.s1d2'), key: syntheticKey }),
    ).rejects.toThrow('backup operation failed');

    await writeFile(join(root, 'truncated.s1d2'), original.subarray(0, -7), { flag: 'wx' });
    await expect(
      readEncryptedBackup({ archivePath: join(root, 'truncated.s1d2'), key: syntheticKey }),
    ).rejects.toThrow('backup operation failed');

    const headerLength = original.readUInt32BE('TEER-S1D2-BACKUP\0'.length);
    const checksumHeader = Buffer.from(original);
    const checksumPosition =
      'TEER-S1D2-BACKUP\0'.length +
      4 +
      checksumHeader
        .subarray('TEER-S1D2-BACKUP\0'.length + 4, 'TEER-S1D2-BACKUP\0'.length + 4 + headerLength)
        .indexOf(Buffer.from('"ciphertextSha256"')) +
      20;
    checksumHeader[checksumPosition] ^= 0x01;
    await writeFile(join(root, 'checksum.s1d2'), checksumHeader, { flag: 'wx' });
    await expect(
      readEncryptedBackup({ archivePath: join(root, 'checksum.s1d2'), key: syntheticKey }),
    ).rejects.toThrow('backup operation failed');

    const unknown = Buffer.from(original);
    const headerStart = 'TEER-S1D2-BACKUP\0'.length + 4;
    const header = JSON.parse(
      unknown.subarray(headerStart, headerStart + headerLength).toString('utf8'),
    ) as Record<string, unknown>;
    header.formatVersion = 99;
    const encoded = Buffer.from(JSON.stringify(header), 'utf8');
    encoded.copy(unknown, headerStart);
    await writeFile(join(root, 'unknown.s1d2'), unknown, { flag: 'wx' });
    await expect(
      readEncryptedBackup({ archivePath: join(root, 'unknown.s1d2'), key: syntheticKey }),
    ).rejects.toThrow('backup operation failed');
    await expect(
      readEncryptedBackup({ archivePath: join(root, 'missing.s1d2'), key: syntheticKey }),
    ).rejects.toThrow();
    await expect(
      readEncryptedBackup({ archivePath: archive, key: Buffer.alloc(32, 0x2b) }),
    ).rejects.toThrow('backup operation failed');
  });

  it('extracts only safe components and restores no remote target', async () => {
    const root = await workspace();
    const input = join(root, 'input');
    const archive = join(root, 'backup.s1d2');
    await mkdir(input, { recursive: true });
    await writeFile(join(input, 'db.sql'), 'synthetic database dump', { flag: 'wx' });
    await createEncryptedBackup({ inputDir: input, outputPath: archive, key: syntheticKey });
    const output = join(root, 'output');
    await extractEncryptedBackup({ archivePath: archive, outputDir: output, key: syntheticKey });
    expect(await readFile(join(output, 'db.sql'), 'utf8')).toBe('synthetic database dump');
    await expect(
      restoreEncryptedBackupToLocal({
        archivePath: archive,
        container: 'remote.example.invalid',
        database: 'production',
        key: syntheticKey,
        workspaceDir: join(root, 'restore'),
        confirmLocalRestore: true,
      }),
    ).rejects.toThrow('restore operation failed');
  });

  it('cleans an extraction directory when restoration input is incomplete', async () => {
    const root = await workspace();
    const input = join(root, 'input');
    const archive = join(root, 'backup.s1d2');
    const extraction = join(root, 'extraction');
    await mkdir(input, { recursive: true });
    await writeFile(join(input, 'metadata.json'), '{}', { flag: 'wx' });
    await createEncryptedBackup({ inputDir: input, outputPath: archive, key: syntheticKey });
    await expect(
      restoreEncryptedBackupToLocal({
        archivePath: archive,
        container: 'supabase_db_teer-dev',
        database: 's1d2_target_synthetic',
        key: syntheticKey,
        workspaceDir: extraction,
        confirmLocalRestore: true,
      }),
    ).rejects.toThrow();
    await expect(readFile(join(extraction, 'metadata.json'))).rejects.toThrow();
  });

  it('does not make a generated component hash part of the plaintext archive', async () => {
    const root = await workspace();
    const input = join(root, 'input');
    const archive = join(root, 'backup.s1d2');
    await mkdir(input, { recursive: true });
    const bytes = randomBytes(32);
    await writeFile(join(input, 'db.sql'), bytes, { flag: 'wx' });
    await createEncryptedBackup({ inputDir: input, outputPath: archive, key: syntheticKey });
    expect(
      await archiveContainsPlaintext({
        archivePath: archive,
        plaintext: createHash('sha256').update(bytes).digest('hex'),
      }),
    ).toBe(false);
  });
});
