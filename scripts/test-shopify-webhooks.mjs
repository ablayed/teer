import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const isWindows = process.platform === 'win32';
const nodeCommand = process.execPath;
const playwrightCli = 'node_modules/@playwright/test/cli.js';
const hmacSecret = createHash('sha256').update('teer-s2-shopify-webhook-harness').digest('hex');

function loadEnvFile(path, override = false) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value =
      rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue.startsWith("'") && rawValue.endsWith("'")
          ? rawValue.slice(1, -1)
          : rawValue;
    if (override || !(key in process.env)) process.env[key] = value;
  }
}

// This harness creates and removes fixture data. Force the isolated test
// Supabase target even when the shell inherited cloud values from `.env.local`.
loadEnvFile('.env.test', true);
loadEnvFile('.env.test.local', true);

const environment = {
  ...process.env,
  E2E_EXTERNAL_SERVER: '1',
  E2E_PROD_BUILD: '1',
  E2E_TEST_MODE: '1',
  SHOPIFY_API_KEY: 's2-e2e-shopify-app',
  SHOPIFY_API_SECRET: hmacSecret,
  VERCEL_ENV: 'preview',
};

const server = spawn(nodeCommand, ['node_modules/next/dist/bin/next', 'start'], {
  cwd: process.cwd(),
  env: environment,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk.toString();
});

async function waitForServer() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://localhost:3000/');
      if (response.status < 500) return;
    } catch {
      // Le serveur n'est pas encore prêt.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('E2E server readiness timeout');
}

function stopServer() {
  if (!server.pid) return;
  if (isWindows) {
    spawnSync('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  } else {
    server.kill('SIGTERM');
  }
}

let exitCode = 1;
try {
  await waitForServer();
  const result = spawnSync(
    nodeCommand,
    [
      playwrightCli,
      'test',
      'tests/e2e/shopify-webhooks.spec.ts',
      '--project=chromium',
      ...process.argv.slice(2),
    ],
    { cwd: process.cwd(), env: environment, stdio: 'inherit' },
  );
  exitCode = result.status ?? 1;
} finally {
  stopServer();
  if (exitCode !== 0 && serverOutput) {
    const logFlags = {
      dedup: serverOutput.includes('[webhook] dedup insert failed'),
      duplicateLookup: serverOutput.includes('[webhook] duplicate lookup failed'),
      shopLookup: serverOutput.includes('[webhook] shop lookup failed'),
    };
    process.stderr.write(`E2E server diagnostic flags: ${JSON.stringify(logFlags)}\n`);
    const safeServerLines = serverOutput
      .split(/\r?\n/)
      .filter((line) =>
        /\[webhook\] (dedup insert failed|duplicate lookup failed|shop lookup failed)/.test(line),
      )
      .map((line) => line.replace(/\s+$/, ''));
    if (safeServerLines.length > 0) {
      process.stderr.write(`${safeServerLines.join('\n')}\n`);
    }
  }
}

process.exitCode = exitCode;
