import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalRedis } from './local-redis.mjs';

// Run the unchanged authorization expectations against F2 with a real local Redis.
// While PRs are separate, the reviewed M1 script can be supplied as argv[2].
const matrix = path.resolve(process.argv[2] ?? 'tests/security/m1-authorization-matrix.mjs');
const applicationRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
assert.equal(
  path.resolve(process.cwd()).toLowerCase(),
  applicationRoot.toLowerCase(),
  'run from the application checkout containing the build',
);
const workspace =
  path.basename(path.dirname(applicationRoot)) === '.worktrees'
    ? path.dirname(path.dirname(applicationRoot))
    : applicationRoot;
assert.ok(matrix.toLowerCase().startsWith(`${workspace.toLowerCase()}${path.sep}`));
assert.equal(path.basename(matrix), 'm1-authorization-matrix.mjs');
assert.ok(
  fs.existsSync(matrix),
  'M1 matrix is required; merge/review M1 first or supply its local path',
);
const local = await startLocalRedis();
try {
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', matrix], {
    env: { ...process.env, M1_LOCAL_REDIS_URL: local.url, M1_LOCAL_REDIS_TOKEN: local.token },
    stdio: 'inherit',
    windowsHide: true,
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status) => resolve(status ?? 1));
  });
  process.exitCode = code;
} finally {
  await local.stop();
}
