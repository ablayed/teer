import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_ALGORITHM = 'aes-256-gcm';
export const BACKUP_KEY_ENV = 'S1D2_BACKUP_KEY';

const MAGIC = Buffer.from('TEER-S1D2-BACKUP\0', 'ascii');
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const MAX_HEADER_LENGTH = 16 * 1024;
const MAX_COMPONENTS = 2048;

function fail() {
  throw new Error('backup operation failed');
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
    fail();
  }
  return key;
}

export function parseBackupKey(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    fail();
  }
  return Buffer.from(value, 'hex');
}

export function keyFromEnvironment(env = process.env) {
  return parseBackupKey(env[BACKUP_KEY_ENV]);
}

function keyIdentifier(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isSafeComponentName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 160 &&
    !name.includes('..') &&
    !name.startsWith('/') &&
    !name.includes('\\') &&
    /^[a-z0-9][a-z0-9._/-]*$/i.test(name)
  );
}

function canonicalHeader({ formatVersion, algorithm, keyId, nonce, ciphertextLength }) {
  return JSON.stringify({ formatVersion, algorithm, keyId, nonce, ciphertextLength });
}

function encodeHeader(header) {
  return Buffer.from(JSON.stringify(header), 'utf8');
}

function decodeHeader(buffer) {
  if (buffer.length > MAX_HEADER_LENGTH) {
    fail();
  }
  try {
    const value = JSON.parse(buffer.toString('utf8'));
    if (
      value?.formatVersion !== BACKUP_FORMAT_VERSION ||
      value?.algorithm !== BACKUP_ALGORITHM ||
      typeof value.keyId !== 'string' ||
      !/^[0-9a-f]{16}$/i.test(value.keyId) ||
      typeof value.nonce !== 'string' ||
      !/^[0-9a-f]{24}$/i.test(value.nonce) ||
      !Number.isSafeInteger(value.ciphertextLength) ||
      value.ciphertextLength < AUTH_TAG_LENGTH ||
      typeof value.ciphertextSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(value.ciphertextSha256)
    ) {
      fail();
    }
    return value;
  } catch {
    fail();
  }
}

function archiveBufferFromPayload(payload, key) {
  assertKey(key);
  const nonce = randomBytes(IV_LENGTH);
  const keyId = keyIdentifier(key);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertextLength = plaintext.length + AUTH_TAG_LENGTH;
  const headerBase = {
    formatVersion: BACKUP_FORMAT_VERSION,
    algorithm: BACKUP_ALGORITHM,
    keyId,
    nonce: nonce.toString('hex'),
    ciphertextLength,
  };
  const cipher = createCipheriv(BACKUP_ALGORITHM, key, nonce);
  cipher.setAAD(Buffer.from(canonicalHeader(headerBase), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const ciphertextWithTag = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  const header = encodeHeader({
    ...headerBase,
    ciphertextSha256: sha256(ciphertextWithTag),
  });
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(header.length, 0);
  return Buffer.concat([MAGIC, length, header, ciphertextWithTag]);
}

function payloadFromArchive(buffer, key) {
  assertKey(key);
  if (!Buffer.isBuffer(buffer) || buffer.length < MAGIC.length + 4 + AUTH_TAG_LENGTH) {
    fail();
  }
  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    fail();
  }
  const headerLength = buffer.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  const headerEnd = headerStart + headerLength;
  if (headerLength === 0 || headerEnd > buffer.length) {
    fail();
  }
  const header = decodeHeader(buffer.subarray(headerStart, headerEnd));
  const ciphertextWithTag = buffer.subarray(headerEnd);
  if (ciphertextWithTag.length !== header.ciphertextLength) {
    fail();
  }
  const expectedChecksum = Buffer.from(header.ciphertextSha256, 'hex');
  const actualChecksum = Buffer.from(sha256(ciphertextWithTag), 'hex');
  if (!timingSafeEqual(expectedChecksum, actualChecksum)) {
    fail();
  }
  if (header.keyId !== keyIdentifier(key)) {
    fail();
  }
  try {
    const nonce = Buffer.from(header.nonce, 'hex');
    const decipher = createDecipheriv(BACKUP_ALGORITHM, key, nonce);
    decipher.setAAD(
      Buffer.from(
        canonicalHeader({
          formatVersion: header.formatVersion,
          algorithm: header.algorithm,
          keyId: header.keyId,
          nonce: header.nonce,
          ciphertextLength: header.ciphertextLength,
        }),
        'utf8',
      ),
    );
    decipher.setAuthTag(ciphertextWithTag.subarray(-AUTH_TAG_LENGTH));
    const plaintext = Buffer.concat([
      decipher.update(ciphertextWithTag.subarray(0, -AUTH_TAG_LENGTH)),
      decipher.final(),
    ]);
    const payload = JSON.parse(plaintext.toString('utf8'));
    if (
      payload?.formatVersion !== BACKUP_FORMAT_VERSION ||
      payload?.archivePurpose !== 's1d2-local-backup' ||
      !Array.isArray(payload.components) ||
      payload.components.length > MAX_COMPONENTS ||
      typeof payload.files !== 'object' ||
      payload.files === null
    ) {
      fail();
    }
    for (const component of payload.components) {
      if (
        !isSafeComponentName(component.name) ||
        !Number.isSafeInteger(component.size) ||
        component.size < 0 ||
        typeof component.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(component.sha256) ||
        typeof payload.files[component.name] !== 'string'
      ) {
        fail();
      }
      const content = Buffer.from(payload.files[component.name], 'base64');
      if (content.length !== component.size || sha256(content) !== component.sha256) {
        fail();
      }
    }
    return { header, payload };
  } catch {
    fail();
  }
}

async function collectFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, path)));
    } else if (entry.isFile()) {
      const name = relative(root, path).split(sep).join('/');
      if (!isSafeComponentName(name)) {
        fail();
      }
      files.push({ name, path });
    } else {
      fail();
    }
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

export async function createEncryptedBackup({ inputDir, outputPath, key, metadata = {} }) {
  const root = resolve(inputDir);
  const output = resolve(outputPath);
  const currentDirectory = resolve(process.cwd());
  if (output === currentDirectory || output.startsWith(`${currentDirectory}${sep}`)) {
    fail();
  }
  const files = await collectFiles(root);
  if (files.length > MAX_COMPONENTS) {
    fail();
  }
  const components = [];
  const contents = {};
  for (const file of files) {
    const content = await readFile(file.path);
    components.push({ name: file.name, size: content.length, sha256: sha256(content) });
    contents[file.name] = content.toString('base64');
  }
  const payload = {
    formatVersion: BACKUP_FORMAT_VERSION,
    archivePurpose: 's1d2-local-backup',
    createdAt: new Date().toISOString(),
    metadata: { ...metadata },
    components,
    files: contents,
  };
  const archive = archiveBufferFromPayload(payload, key);
  await mkdir(dirname(output), { recursive: true });
  const partial = `${output}.${process.pid}.partial`;
  try {
    await writeFile(partial, archive, { flag: 'wx' });
    await rename(partial, output);
  } finally {
    await rm(partial, { force: true });
  }
  return { outputPath: output, bytes: archive.length, components: components.length };
}

export async function readEncryptedBackup({ archivePath, key }) {
  try {
    const archive = await readFile(resolve(archivePath));
    return payloadFromArchive(archive, key);
  } catch {
    fail();
  }
}

export async function extractEncryptedBackup({ archivePath, outputDir, key }) {
  const { header, payload } = await readEncryptedBackup({ archivePath, key });
  const root = resolve(outputDir);
  await mkdir(root, { recursive: true });
  for (const component of payload.components) {
    const destination = resolve(root, component.name);
    if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
      fail();
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(payload.files[component.name], 'base64'), {
      flag: 'wx',
    });
  }
  return { header, payload, outputDir: root };
}

export async function archiveContainsPlaintext({ archivePath, plaintext }) {
  const archive = await readFile(resolve(archivePath));
  return archive.includes(Buffer.from(plaintext, 'utf8'));
}

export async function assertNoArchiveAt(path) {
  try {
    await stat(resolve(path));
    fail();
  } catch (error) {
    if (error?.message === 'backup operation failed') {
      throw error;
    }
  }
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const key = keyFromEnvironment();
  if (mode === 'pack') {
    const inputDir = argumentValue(args, '--input-dir');
    const outputPath = argumentValue(args, '--output');
    if (!inputDir || !outputPath) fail();
    await createEncryptedBackup({ inputDir, outputPath, key });
    return;
  }
  if (mode === 'verify') {
    const archivePath = argumentValue(args, '--archive');
    if (!archivePath) fail();
    await readEncryptedBackup({ archivePath, key });
    return;
  }
  if (mode === 'extract') {
    const archivePath = argumentValue(args, '--archive');
    const outputDir = argumentValue(args, '--output-dir');
    if (!archivePath || !outputDir) fail();
    await extractEncryptedBackup({ archivePath, outputDir, key });
    return;
  }
  fail();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => {
    process.stderr.write('backup operation failed\n');
    process.exitCode = 1;
  });
}
