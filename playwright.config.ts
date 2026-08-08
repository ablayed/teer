import { existsSync, readFileSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import {
  SHOPIFY_E2E_CLIENT_ID,
  SHOPIFY_E2E_HMAC_SECRET,
} from './tests/e2e/helpers/shopify-webhook-harness';

function loadEnvFile(path: string) {
  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value =
      rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue.startsWith("'") && rawValue.endsWith("'")
          ? rawValue.slice(1, -1)
          : rawValue;

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile('.env.test.local');
loadEnvFile('.env.test');

if (process.env.E2E_SHOPIFY_WEBHOOKS === '1') {
  // Le serveur Next charge parfois une configuration locale différente du processus Playwright.
  // Le mode explicite impose une paire synthétique commune aux deux côtés du test.
  process.env.SHOPIFY_API_KEY = SHOPIFY_E2E_CLIENT_ID;
  process.env.SHOPIFY_API_SECRET = SHOPIFY_E2E_HMAC_SECRET;
}

process.env.E2E_TEST_MODE = '1';
// La galerie primitive est une surface explicitement test-only ; les baselines doivent atteindre
// ses composants au lieu de capturer le 404 produit par sa garde d’environnement.
process.env.ENABLE_PRIMITIVES_DEMO = '1';

const isCI = !!process.env.CI;
const externalServer = process.env.E2E_EXTERNAL_SERVER === '1';

export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  retries: isCI ? 1 : 0,
  reporter: isCI ? 'blob' : 'list',
  workers: 1,
  snapshotPathTemplate:
    '{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}-{platform}{ext}',
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.01,
    },
  },
  use: {
    baseURL: process.env.E2E_URL ?? 'http://localhost:3000',
    locale: 'fr-FR',
    timezoneId: 'Africa/Dakar',
    // Capture une trace au 1er retry (et donc sur l'échec final, retries=1) pour diagnostiquer
    // les actions qui pendent (call log + snapshot DOM/ARIA au timeout). Uploadée en CI on-failure.
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'pixel-7', use: { ...devices['Pixel 7'] } },
    { name: 'iphone-14', use: { ...devices['iPhone 14'] }, timeout: 90_000 },
  ],
  webServer: externalServer
    ? undefined
    : {
        // En mode E2E_PROD_BUILD=1, on sert un VRAI build de prod (`next start`) pour
        // reproduire les bugs PROD-ONLY (Router Cache client, cf. issue #3) que `next dev`
        // ne montre pas. Le build doit avoir été produit AVANT (cf. workflow e2e-prod.yml).
        // Sinon, dev classique.
        // Exécuter Next directement évite de laisser un wrapper pnpm survivre à l'arrêt
        // du serveur sur Windows, ce qui faisait expirer Playwright après des tests réussis.
        command:
          process.env.E2E_PROD_BUILD === '1'
            ? 'node node_modules/next/dist/bin/next start'
            : 'node node_modules/next/dist/bin/next dev',
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 180_000,
      },
});
