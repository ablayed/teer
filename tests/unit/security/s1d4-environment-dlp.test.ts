import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mapSupabaseAuthError } from '@/lib/actions/auth-errors';
import { getCountdown, isExpired } from '@/lib/auth/idle-utils';
import { checkPasswordStrength } from '@/lib/format/password';
import {
  PUBLIC_BROWSER_ENV_NAMES,
  SERVER_ONLY_ENV_NAMES,
  classifyDeploymentEnvironment,
  isPublicBrowserEnvironmentName,
  isServerOnlyEnvironmentName,
} from '@/lib/security/s1d4-boundaries';
import { sanitizePostHogEvent, sanitizeSentryEvent } from '@/lib/security/telemetry-sanitize';
import type { CaptureResult } from 'posthog-js';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(file), 'utf8');

function sourceFiles(directory: string): string[] {
  const absolute = resolve(directory);
  if (!existsSync(absolute)) return [];

  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.env')) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx|js|jsx|mjs)$/.test(entry.name) ? [path] : [];
  });
}

describe('S1D-4 environment and DLP boundary', () => {
  it('keeps the public environment allowlist disjoint from server-only credentials', () => {
    for (const name of PUBLIC_BROWSER_ENV_NAMES) {
      expect(isPublicBrowserEnvironmentName(name)).toBe(true);
      expect(isServerOnlyEnvironmentName(name)).toBe(false);
    }
    for (const name of SERVER_ONLY_ENV_NAMES) {
      expect(isServerOnlyEnvironmentName(name)).toBe(true);
      expect(isPublicBrowserEnvironmentName(name)).toBe(false);
    }

    const envSource = read('lib/env.ts');
    const publicBlock = envSource.slice(
      envSource.indexOf('const rawPublicEnv'),
      envSource.indexOf('export const publicEnv'),
    );
    for (const name of SERVER_ONLY_ENV_NAMES) {
      expect(publicBlock).not.toContain(name);
    }
  });

  it('rejects server-only imports and environment reads in client modules', () => {
    const clientFiles = [
      ...sourceFiles('app'),
      ...sourceFiles('components'),
      ...sourceFiles('lib'),
    ].filter((file) => /['"]use client['"]/.test(read(file)));

    expect(clientFiles.length).toBeGreaterThan(0);
    for (const file of clientFiles) {
      const source = read(file);
      expect(source, file).not.toMatch(/(?:from|import\()\s*['"](?:@\/)?lib\/env['"]/);
      for (const name of SERVER_ONLY_ENV_NAMES) {
        expect(source, `${file} contains ${name}`).not.toContain(`process.env.${name}`);
        expect(source, `${file} contains ${name}`).not.toContain(`env.${name}`);
      }
    }

    const browserClient = read('lib/supabase/client.ts');
    expect(browserClient).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('classifies local, test, preview and production without network calls', () => {
    expect(classifyDeploymentEnvironment({ NODE_ENV: 'development' })).toBe('local');
    expect(classifyDeploymentEnvironment({ NODE_ENV: 'test', CI: 'true' })).toBe('test');
    expect(classifyDeploymentEnvironment({ NODE_ENV: 'production', VERCEL_ENV: 'preview' })).toBe(
      'preview',
    );
    expect(
      classifyDeploymentEnvironment({ NODE_ENV: 'production', VERCEL_ENV: 'production' }),
    ).toBe('production');
  });

  it('removes synthetic PCD, credentials, cookies and raw URLs from telemetry', () => {
    const canary = 'S1D4_SYNTHETIC_PCD_CANARY';
    const sentry = sanitizeSentryEvent({
      user: { email: canary },
      request: {
        url: `https://synthetic.invalid/orders/${canary}?customer=${canary}`,
        headers: canary,
      },
      breadcrumbs: [{ category: canary, message: canary }],
      exception: { values: [{ type: canary, value: canary }] },
      transaction: canary,
      tags: { customer: canary, action: 'orders.view' },
      extra: { customer: canary, pathname: `/orders/${canary}`, actionName: canary },
    });
    expect(JSON.stringify(sentry)).not.toContain(canary);
    expect(sentry.request?.url).toBe('/orders/:id');

    const posthog = sanitizePostHogEvent({
      event: canary,
      user: canary,
      properties: {
        arbitrary_customer_ref: canary,
        nested: { customer: canary },
        pathname: `/orders/${canary}`,
        count: 2,
        action: 'orders.view',
      },
    } as unknown as CaptureResult);
    expect(JSON.stringify(posthog)).not.toContain(canary);
    expect(posthog?.properties).toMatchObject({ count: 2, action: 'orders.view' });
  });

  it('proves password, generic-auth-error and session controls without exposing credentials', () => {
    expect(checkPasswordStrength('weak')).toMatchObject({ allValid: false });
    expect(checkPasswordStrength('StrongLocal1!')).toMatchObject({ allValid: true });
    expect(mapSupabaseAuthError({ message: 'invalid login credentials' })).toBe(
      'invalid_credentials',
    );
    expect(mapSupabaseAuthError({ message: 'user not found' })).not.toBe('user_not_found');
    expect(isExpired(0, 10_000, 10_000)).toBe(true);
    expect(getCountdown(0, 7_500, 10_000)).toBe(3);
    expect(read('lib/actions/auth.ts')).not.toContain('extra: { password:');
    expect(read('lib/actions/account.ts')).toContain('signInWithPassword');
  });

  it('keeps CI and the repository free of tracked sensitive artifacts', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    expect(
      tracked.some((file) =>
        /(^|\/)(playwright-report|test-results|blob-report|coverage)(\/|$)/.test(file),
      ),
    ).toBe(false);
    expect(tracked.some((file) => /\.(?:dump|backup|sqlite|db|tar|tgz|zip)$/i.test(file))).toBe(
      false,
    );
    expect(read('.gitignore')).toContain('playwright-report');
    expect(read('.gitignore')).toContain('test-results');

    const workflow = read('.github/workflows/ci.yml');
    expect(workflow).toContain('Remove test environment files');
    expect(workflow).toContain('retention-days: 7');
    expect(workflow).not.toMatch(/echo\s+[^\n]*SUPABASE_SERVICE_ROLE_KEY/i);
  });
});
